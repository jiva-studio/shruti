import Foundation

// iOS analogue of android/app/src/main/java/studio/akdasa/shruti/BundledDatabaseHelper.java.
//
// Copies bundled .db files shipped inside the app bundle (App.bundle/databases/*.db)
// to the location the rest of the stack reads on iOS:
//   Documents/shruti/databases/
//
// This matches:
//   - @capacitor/filesystem Directory.Data (maps to .documentDirectory on iOS),
//     used by useCapacitorSqlPersistence.ensureDirectoryExists and
//     WelcomeView.findLocalDatabase.
//   - @capacitor-community/sqlite getNCDatabasePath("Documents/shruti/databases", ...),
//     whose iOS UtilsFile.getFolderURL whitelist accepts "Documents" as the first
//     path segment.
//
// Idempotent: skips files that already exist at the target.
enum BundledDatabaseHelper {
    private static let sourceDir = "databases"
    private static let targetSubdir = "shruti/databases"

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

        for file in files where file.hasSuffix(".db") {
            let src = source.appendingPathComponent(file)
            let dst = target.appendingPathComponent(file)
            if fm.fileExists(atPath: dst.path) { continue }
            do {
                try fm.copyItem(at: src, to: dst)
                let size = (try? fm.attributesOfItem(atPath: dst.path)[.size] as? Int) ?? 0
                NSLog("[BundledDatabaseHelper] Copied %@ (%d bytes)", file, size)
            } catch {
                NSLog("[BundledDatabaseHelper] Failed to copy %@: %@", file, error.localizedDescription)
            }
        }
    }
}
