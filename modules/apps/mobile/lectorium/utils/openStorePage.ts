import { Capacitor } from "@capacitor/core"

/**
 * Bundle id of the Android build — matches `capacitor.config.ts` and
 * `android/app/build.gradle`'s `applicationId`. Hard-coded because it's
 * the deployment identity, not a runtime config.
 */
const ANDROID_PACKAGE = "studio.jiva.shruti"

/**
 * App Store numeric id of the iOS build — verified in
 * `ios/App/DevStoreKit.storekit` (`_applicationInternalID`). Listing
 * name is "Shruti" but we always hand users the canonical
 * `id<...>` URL, which redirects to the localised listing.
 */
const IOS_APP_ID = "6745510353"

/**
 * Open the platform's store page for Lectorium so the user can update.
 * Used by the chat protocol-mismatch toast CTA — when the server
 * rejects our `X-Chat-Protocol-Version` with 426 we tell the user the
 * app is out of date and offer this one-tap shortcut to the store.
 *
 * Web fallback drops the user on the marketing site rather than a
 * store page they don't have. The WebView wraps `window.open` to a
 * system browser intent on native, so no extra `Browser.open` plumbing
 * is needed here.
 */
export function openStorePage(): void {
  const platform = Capacitor.getPlatform()
  let url: string
  if (platform === "ios") {
    url = `https://apps.apple.com/app/id${IOS_APP_ID}`
  } else if (platform === "android") {
    url = `https://play.google.com/store/apps/details?id=${ANDROID_PACKAGE}`
  } else {
    url = "https://lectorium.akdasa.studio"
  }
  window.open(url, "_blank")
}
