import Foundation

class DatabaseHelper {
    /// Copies a database from the app's bundle to the Library directory
    /// - Parameters:
    ///   - sourceFileName: Name of the source database file in the app's bundle
    ///   - destinationFileName: Name of the destination file in the Library directory
    /// - Returns: Boolean indicating whether the copy was successful
    static func copyDatabaseIfNeeded(
        sourceFileName: String,
        destinationFileName: String
    ) -> Bool {
        let fileManager = FileManager.default
        
        // Construct destination URL
        guard let libraryDirectory = fileManager.urls(for: .libraryDirectory, in: .userDomainMask).first else {
            print("Error: Could not access Library directory")
            return false
        }
        
        let destinationURL = libraryDirectory.appendingPathComponent(destinationFileName)
        
        // Check if database already exists at destination
        if fileManager.fileExists(atPath: destinationURL.path) {
            print("Database already exists at: \(destinationURL.path)")
            return true
        }
        
        // Create destination directory if it doesn't exist
        let destinationDirectory = destinationURL.deletingLastPathComponent()
        do {
            try fileManager.createDirectory(at: destinationDirectory, withIntermediateDirectories: true, attributes: nil)
            print("Created destination directory: \(destinationDirectory.path)")
        } catch {
            print("Error creating destination directory: \(error.localizedDescription)")
            return false
        }
        
        // Get source file URL from bundle
        guard let sourceURL = Bundle.main.url(forResource: sourceFileName, withExtension: "db") else {
            print("Error: Source database file not found in bundle for resource: \(sourceFileName)")
            return false
        }
        
        // Verify source file exists and is accessible
        if !fileManager.fileExists(atPath: sourceURL.path) {
            print("Error: Source file does not exist at: \(sourceURL.path)")
            return false
        }
        
        // Attempt to copy the file
        do {
            try fileManager.copyItem(at: sourceURL, to: destinationURL)
            print("Database successfully copied to: \(destinationURL.path)")
            return true
        } catch {
            print("Error copying database: \(error.localizedDescription)")
            print("Source URL: \(sourceURL)")
            print("Destination URL: \(destinationURL)")
            return false
        }
    }
    
    func setupDatabase() {
        let _ = DatabaseHelper.copyDatabaseIfNeeded(
            sourceFileName: "dictionary",
            destinationFileName: "LocalDatabase/dictionary.db"
        )
        let _ = DatabaseHelper.copyDatabaseIfNeeded(
            sourceFileName: "tracks",
            destinationFileName: "LocalDatabase/tracks.db"
        )
        let _ = DatabaseHelper.copyDatabaseIfNeeded(
            sourceFileName: "index",
            destinationFileName: "LocalDatabase/index.db"
        )
    }
}
