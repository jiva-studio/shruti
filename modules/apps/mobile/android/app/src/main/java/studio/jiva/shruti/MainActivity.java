package studio.jiva.shruti;

import android.os.Bundle;
import android.webkit.WebView;

import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  @Override
  public void onCreate(Bundle savedInstanceState) {
    // Copy prebuilt databases from APK assets into the app's writable
    // storage before Capacitor initializes — the SQLite plugin looks for
    // them under getFilesDir()/shruti/databases/ and we can't race
    // that lookup with the copy.
    new BundledDatabaseHelper(this).copyBundledDatabases();

    super.onCreate(savedInstanceState);
  }

  @Override
  public void onStart() {
    super.onStart();
    WebView v = getBridge().getWebView();
    // Disable the rubber-band over-scroll effect: the WebView stretching
    // does not take `position: fixed` elements into account, which makes
    // the Ionic UI get stretched.
    // https://github.com/ionic-team/capacitor/issues/5384#issuecomment-1165811208
    v.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
    // Match the WebView's default background to the Ionic theme so the
    // brief gap between native splash dismissal and the first CSS paint
    // does not flash white. Day/night-aware via @color/webview_background.
    v.setBackgroundColor(ContextCompat.getColor(this, R.color.webview_background));
  }
}
