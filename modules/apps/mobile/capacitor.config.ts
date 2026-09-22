import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: process.env.APP_ID || process.env.APPLICATION_ID || process.env.ANDROID_PACKAGE_NAME || process.env.IOS_BUNDLE_ID || "studio.jiva.shruti",
  appName: process.env.APP_NAME || "shruti",
  webDir: "dist",
  // TODO: don't use this in production
  server: {
    cleartext: true,
    androidScheme: "http",
  },
  plugins: {
    // We never use encrypted SQLite (all connections open "no-encryption",
    // no setEncryptionSecret call exists). The plugin defaults isEncryption to
    // true, which forces a synchronous Tink MasterKey / EncryptedSharedPreferences
    // init on the main thread at plugin load — the cause of the startup ANRs in
    // MainActivity.onCreate / AudioPlayerService.onCreate on low-end Android.
    CapacitorSQLite: {
      androidIsEncryption: false,
    },
    // `@capgo/capacitor-social-login` reads provider toggles from this
    // block in `scripts/configure-dependencies.js` (runs during
    // `cap sync`). We only wire Google + Apple in `useCapacitorAuth.ts`
    // — Facebook + Twitter are off so their SDKs (and the
    // `com.google.android.gms.permission.AD_ID` permission Facebook
    // SDK 17+ injects, which Play Console rejects) never make it into
    // the merged AndroidManifest. The gradle `-P` flags can NOT
    // override this — the plugin's hook script writes its own
    // gradle.properties at sync time from the values it reads here.
    SocialLogin: {
      providers: {
        google: true,
        apple: true,
        facebook: false,
        twitter: false,
      },
    },
  },
}
export default config
