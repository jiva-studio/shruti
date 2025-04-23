package studios.akdasa.lectorium;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Copy the database from assets to the databases folder
    DatabaseHelper databaseHelper = new DatabaseHelper(this);
    try {
      databaseHelper.copyDatabaseFromAssets("tracks.db");
      databaseHelper.copyDatabaseFromAssets("dictionary.db");
      databaseHelper.copyDatabaseFromAssets("index.db");
    } catch (RuntimeException e) {
      e.printStackTrace();
    }
  }

  @Override
  public void onStart() {
    super.onStart();
    // Disable the rubber-band over-scroll effect.
    // The `WebView` stretching does not take `position: fixed` elements into account, which
    // causes the app UI to get stretched.
    // https://github.com/ionic-team/capacitor/issues/5384#issuecomment-1165811208
    WebView v = getBridge().getWebView();
    v.setOverScrollMode(v.OVER_SCROLL_NEVER);
  }
}
