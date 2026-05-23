import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "studio.jiva.shruti",
  appName: "lectorium",
  webDir: "dist",
  // TODO: don't use this in production
  server: {
    cleartext: true,
    androidScheme: "http",
  },
  plugins: {
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
