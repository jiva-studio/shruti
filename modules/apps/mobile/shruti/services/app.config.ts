import type { AppConfig } from "../shruti.js"

/**
 * Default runtime configuration. `__DB_SCHEME__` comes from Vite `define`
 * and is the source of truth for the scheme this client expects. The region
 * list is no longer here — it lives in the runtime registry
 * (regionsRegistry), bootstrapped from servers.ts and refreshed from the
 * downloaded config.json.
 */
declare const __APP_NAME__: string | undefined
declare const __PUBLIC_REMOTE_CONFIG_PATH__: string | undefined
declare const __DATABASE_LOCAL_PATH_TEMPLATE__: string | undefined
declare const __DATABASE_REMOTE_PATH_TEMPLATE__: string | undefined
declare const __DATABASE_USER_LOCAL_PATH__: string | undefined

const appName = (typeof __APP_NAME__ !== "undefined" && __APP_NAME__) || "shruti"

export const DEFAULT_APP_CONFIG: AppConfig = {
  database: {
    localPathTemplate:
      (typeof __DATABASE_LOCAL_PATH_TEMPLATE__ !== "undefined" && __DATABASE_LOCAL_PATH_TEMPLATE__) ||
      `${appName}/databases/${appName}.{version}.db`,
    remotePathTemplate:
      (typeof __DATABASE_REMOTE_PATH_TEMPLATE__ !== "undefined" && __DATABASE_REMOTE_PATH_TEMPLATE__) ||
      `public/db/${appName}.{version}.db`,
    userLocalPath:
      (typeof __DATABASE_USER_LOCAL_PATH__ !== "undefined" && __DATABASE_USER_LOCAL_PATH__) ||
      `${appName}/databases/user.db`,
  },
  publicRemoteConfigPath:
    (typeof __PUBLIC_REMOTE_CONFIG_PATH__ !== "undefined" && __PUBLIC_REMOTE_CONFIG_PATH__) ||
    "public/config.json",
}
