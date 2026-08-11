/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Opt-in flag (`"true"`) that injects the local-dev region — set by the
   *  `local-stack` skill when serving against the local backend stack. */
  readonly VITE_DEV_REGION?: string
  /** Override the local-dev region's auth base URL (default http://localhost:11081/auth). */
  readonly VITE_DEV_AUTH_URL?: string
  /** Override the local-dev region's chat base URL (default http://localhost:11080). */
  readonly VITE_DEV_CHAT_URL?: string
}

declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string
declare const __BUILD_ID__: string
declare const __COMMIT_SHA__: string
declare const __DB_SCHEME__: number
declare const __REVENUECAT_IOS_KEY__: string
declare const __REVENUECAT_ANDROID_KEY__: string
declare const __GOOGLE_WEB_CLIENT_ID__: string
declare const __GOOGLE_IOS_CLIENT_ID__: string
declare const __SENTRY_DSN__: string
declare const __SENTRY_RELEASE__: string
/** True in the off-store build (sideloaded APK) that runs without Google
 *  services: email-only sign-in, no in-app purchase, subscription managed
 *  on the website. */
declare const __OFFSTORE_BUILD__: boolean
/** True only in a build made for the automated tests (`LECTORIUM_E2E_BUILD=1`).
 *  Lets the e2e suite run the app as Pro on purpose; false in every artifact
 *  that reaches a user, so it can never be a way to fake a subscription. */
declare const __E2E_BUILD__: boolean
