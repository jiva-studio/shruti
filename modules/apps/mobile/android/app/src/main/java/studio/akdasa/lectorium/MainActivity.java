package studio.jiva.shruti;

import android.os.Bundle;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Copy prebuilt databases from APK assets into the app's writable
    // storage before Capacitor initializes — the SQLite plugin looks for
    // them under getFilesDir()/lectorium/databases/ and we can't race
    // that lookup with the copy.
    new BundledDatabaseHelper(this).copyBundledDatabases();

    super.onCreate(savedInstanceState);
  }

  @Override
  public void onStart() {
    super.onStart();
    // Disable the rubber-band over-scroll effect: the WebView stretching
    // does not take `position: fixed` elements into account, which makes
    // the Ionic UI get stretched.
    // https://github.com/ionic-team/capacitor/issues/5384#issuecomment-1165811208
    WebView v = getBridge().getWebView();
    v.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
  }
}
