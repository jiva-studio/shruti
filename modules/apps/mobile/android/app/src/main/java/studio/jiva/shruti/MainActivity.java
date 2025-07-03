package studio.jiva.shruti;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.appsflyer.AppsFlyerLib;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginHandle;

import ee.forgr.capacitor.social.login.GoogleProvider;
import ee.forgr.capacitor.social.login.SocialLoginPlugin;
import ee.forgr.capacitor.social.login.ModifiedMainActivityForSocialLoginPlugin;


public class MainActivity extends BridgeActivity implements ModifiedMainActivityForSocialLoginPlugin {
  @Override
  public void onActivityResult(int requestCode, int resultCode, Intent data) {
    super.onActivityResult(requestCode, resultCode, data);

    if (requestCode >= GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MIN && requestCode < GoogleProvider.REQUEST_AUTHORIZE_GOOGLE_MAX) {
      PluginHandle pluginHandle = getBridge().getPlugin("SocialLogin");
      if (pluginHandle == null) {
        Log.i("Google Activity Result", "SocialLogin login handle is null");
        return;
      }
      Plugin plugin = pluginHandle.getInstance();
      if (!(plugin instanceof SocialLoginPlugin)) {
        Log.i("Google Activity Result", "SocialLogin plugin instance is not SocialLoginPlugin");
        return;
      }
      ((SocialLoginPlugin) plugin).handleGoogleLoginIntent(requestCode, data);
    }
  }

  // This function will never be called, leave it empty
  @Override
  public void IHaveModifiedTheMainActivityForTheUseWithSocialLoginPlugin() {}

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // Configure appsflyer
    AppsFlyerLib.getInstance().setDebugLog(true);
    AppsFlyerLib.getInstance().init(
            BuildConfig.APPSFLYER_KEY,
            null,
            getApplicationContext());
    AppsFlyerLib.getInstance().start(getApplicationContext());


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
