package studios.akdasa.lectorium;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

public class DatabaseHelper {
    private final Context context;

    public DatabaseHelper(Context context) {
        this.context = context;
    }

    public void copyDatabaseFromAssets(String databaseName) {
        String databasePath = context.getDatabasePath(databaseName).getPath();

        File databaseFile = new File(databasePath);
        if (databaseFile.exists()) {
            return;
        }

        try {
            // Ensure the databases directory exists
            File parentDir = databaseFile.getParentFile();
            if (parentDir != null) {
                parentDir.mkdirs();
            }

            // Open the database file from assets
            InputStream inputStream = context.getAssets().open("databases/" + databaseName);
            OutputStream outputStream = new FileOutputStream(databaseFile);

            // Copy the file
            byte[] buffer = new byte[1024];
            int length;
            while ((length = inputStream.read(buffer)) > 0) {
                outputStream.write(buffer, 0, length);
            }

            // Close streams
            outputStream.flush();
            outputStream.close();
            inputStream.close();
        } catch (IOException e) {
            e.printStackTrace();
            throw new RuntimeException("Error copying database", e);
        }
    }
}