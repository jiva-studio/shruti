import type { AppConfig } from "../lectorium.js"

/**
 * Default runtime configuration. `__DB_SCHEME__` comes from Vite `define`
 * and is the source of truth for the scheme this client expects. The region
 * list is no longer here — it lives in the runtime registry
 * (regionsRegistry), bootstrapped from servers.ts and refreshed from the
 * downloaded config.json.
 */
export const DEFAULT_APP_CONFIG: AppConfig = {
  database: {
    localPathTemplate: "lectorium/databases/lectorium.{version}.db",
    remotePathTemplate: "public/db/lectorium.{version}.db",
    userLocalPath: "lectorium/databases/user.db",
  },
  publicRemoteConfigPath: "public/config.json",
}
