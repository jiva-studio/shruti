import Foundation

// iOS analogue of android/app/src/main/java/studio/akdasa/lectorium/BundledDatabaseHelper.java.
//
// Copies bundled .db files shipped inside the app bundle (App.bundle/databases/*.db)
// to the location the rest of the stack reads on iOS:
//   Documents/lectorium/databases/
//
// This matches:
//   - @capacitor/filesystem Directory.Data (maps to .documentDirectory on iOS),
//     used by useCapacitorSqlPersistence.ensureDirectoryExists and
//     WelcomeView.findLocalDatabase.
//   - @capacitor-community/sqlite getNCDatabasePath("Documents/lectorium/databases", ...),
//     whose iOS UtilsFile.getFolderURL whitelist accepts "Documents" as the first
//     path segment.
//
// Keep the predicate below in lockstep with the Java one: they are the same
// rule, and drift between them is a boot-time bug on one platform only.
enum BundledDatabaseHelper {
    private static let sourceDir = "databases"
    private static let targetSubdir = "lectorium/databases"
    private static let tempExtension = "copying"

    /// First bytes of every SQLite file. Same gate as the JS side applies in
    /// `infra/persistence/fetchers/fs/useDatabaseToFsFetcher.ts` ("SQLite
    /// format 3\0" plus a minimum size of those 16 bytes), so a file this
    /// helper keeps is a file the JS resolver will also accept.
    private static let sqliteMagicHeader = Data("SQLite format 3\0".utf8)

    /// Copies every bundled catalog that the device does not already hold in a
    /// usable, at-least-as-new form.
    ///
    /// The old rule was "skip when a file with this exact name exists", which
    /// lost a fight with the JS bootstrap: `pruneSuperseded` deletes every
    /// catalog older than the one it opened, and the bundled file is the oldest
    /// by construction — so after the first catalog update the file was pruned
    /// and re-copied on every cold start, forever (#1830).
    static func copyBundledDatabases() {
        guard let resourceURL = Bundle.main.resourceURL else { return }
        let source = resourceURL.appendingPathComponent(sourceDir, isDirectory: true)
        guard FileManager.default.fileExists(atPath: source.path) else { return }

        let fm = FileManager.default
        guard let documents = try? fm.url(
            for: .documentDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        ) else { return }

        let target = documents.appendingPathComponent(targetSubdir, isDirectory: true)
        try? fm.createDirectory(at: target, withIntermediateDirectories: true)

        guard let files = try? fm.contentsOfDirectory(atPath: source.path) else { return }
        let onDisk = (try? fm.contentsOfDirectory(atPath: target.path)) ?? []

        for file in files where file.hasSuffix(".db") {
            guard shouldCopy(asset: file, onDisk: onDisk, in: target) else {
                NSLog("[BundledDatabaseHelper] Usable catalog already on disk, skipping %@", file)
                continue
            }
            let dst = target.appendingPathComponent(file)
            do {
                try copyAsset(from: source.appendingPathComponent(file), to: dst)
                let size = (try? fm.attributesOfItem(atPath: dst.path)[.size] as? Int) ?? 0
                NSLog("[BundledDatabaseHelper] Copied %@ (%d bytes)", file, size)
            } catch {
                NSLog("[BundledDatabaseHelper] Failed to copy %@: %@", file, error.localizedDescription)
            }
        }
    }

    /// Whether the bundled `asset` still has to be written to disk.
    ///
    /// Copy iff no on-disk file matching `^<stem>\.(\d+)\.db$` has a version >=
    /// the asset's AND passes the integrity gate. That is the exact complement
    /// of the JS prune rule (kit `bootstrap/contentDatabaseResolver.ts`
    /// `pruneContentDatabases`, which keeps versions >= the one it opened), so
    /// the two can never fight: an equal or older bundled catalog is skipped, a
    /// NEWER bundled catalog — an app update shipping a fresher one — is copied
    /// and prune then drops the stale on-disk file.
    ///
    /// The version test alone would also skip when the newer file on disk is
    /// truncated or not a database at all, throwing away a good fallback; hence
    /// the header check on the candidate that would justify the skip.
    private static func shouldCopy(asset: String, onDisk: [String], in dir: URL) -> Bool {
        let stem = versionStem(asset)
        guard let assetVersion = parseVersion(asset, stem: stem) else {
            // Asset is not versioned — nothing to compare, fall back to
            // "copy unless a usable file of the same name is already there".
            return !isUsableDatabase(at: dir.appendingPathComponent(asset))
        }

        for candidate in onDisk {
            guard let version = parseVersion(candidate, stem: stem), version >= assetVersion else {
                continue
            }
            if isUsableDatabase(at: dir.appendingPathComponent(candidate)) { return false }
        }
        return true
    }

    /// `"lectorium.42.db"` → `"lectorium"`; the name itself when unversioned.
    private static func versionStem(_ fileName: String) -> String {
        guard let dot = fileName.firstIndex(of: "."), dot != fileName.startIndex else {
            return fileName
        }
        return String(fileName[fileName.startIndex..<dot])
    }

    /// Version in `<stem>.<digits>.db`, or `nil` when it does not match.
    private static func parseVersion(_ fileName: String, stem: String) -> Int? {
        let prefix = stem + "."
        let suffix = ".db"
        guard fileName.hasPrefix(prefix), fileName.hasSuffix(suffix) else { return nil }
        guard fileName.count > prefix.count + suffix.count else { return nil }

        let start = fileName.index(fileName.startIndex, offsetBy: prefix.count)
        let end = fileName.index(fileName.endIndex, offsetBy: -suffix.count)
        let digits = fileName[start..<end]
        guard digits.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        return Int(digits)
    }

    /// SQLite magic header + at least header-many bytes — the JS side's gate, verbatim.
    private static func isUsableDatabase(at url: URL) -> Bool {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return false }
        defer { try? handle.close() }
        guard let header = try? handle.read(upToCount: sqliteMagicHeader.count) else { return false }
        return header == sqliteMagicHeader
    }

    /// Copies to a temp neighbour and moves it into place, so a process kill or
    /// a full disk mid-copy can never leave a truncated file at the canonical
    /// name — which the header-only gate above (and the JS one) would happily
    /// accept. The temp name does not match the versioned pattern, so a
    /// leftover is invisible to this predicate and to the JS prune; the JS
    /// side sweeps `*.copying` alongside the prune instead (#1896).
    private static func copyAsset(from src: URL, to dst: URL) throws {
        let fm = FileManager.default
        let temp = dst.appendingPathExtension(tempExtension)
        try? fm.removeItem(at: temp)

        do {
            try fm.copyItem(at: src, to: temp)
            try flushToDisk(at: temp)
            // `moveItem` refuses an existing destination, and the file we are
            // replacing here is by definition one that failed the gate above.
            try? fm.removeItem(at: dst)
            try fm.moveItem(at: temp, to: dst)
        } catch {
            try? fm.removeItem(at: temp)
            throw error
        }
    }

    /// Durability barrier before the rename — the Swift twin of the Java
    /// `out.getFD().sync()`. Without it the rename can land ahead of the data
    /// and a power loss re-creates the truncated-file case the temp copy
    /// exists to prevent. `fsync` is not enough on APFS: it only hands the
    /// blocks to the drive, which may reorder them behind the metadata, so
    /// this asks for `F_FULLFSYNC` (a full device flush).
    private static func flushToDisk(at url: URL) throws {
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        guard fcntl(handle.fileDescriptor, F_FULLFSYNC) != -1 else {
            throw NSError(
                domain: NSPOSIXErrorDomain,
                code: Int(errno),
                userInfo: [NSLocalizedDescriptionKey:
                    "F_FULLFSYNC failed for \(url.lastPathComponent)"]
            )
        }
    }
}
