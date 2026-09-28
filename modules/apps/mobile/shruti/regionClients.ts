import { deriveProbeObjectPath, useHttpServerProber } from "@infra/servers/index.js"
import type { IPreferences, IServerProber } from "@ports/app/index.js"
import { getRegions, isValidRegionList } from "@shruti/services/regionsRegistry.js"
import {
  createProbeTelemetry,
  readNetworkType,
} from "@shruti/services/monitoring/probeTelemetry.js"

declare const __DB_SCHEME__: number

/**
 * The region prober: reads the content database this build would download
 * from each candidate and reports every run to monitoring.
 */
export function createRegionProber(
  remotePathTemplate: string,
  preferences: IPreferences
): IServerProber {
  const reportProbe = createProbeTelemetry({ preferences })
  return useHttpServerProber({
    getServers: () => getRegions(),
    probeObjectPath: (config) => deriveProbeObjectPath(config, remotePathTemplate, __DB_SCHEME__),
    isValidRegionList,
    onReport: (report) => {
      void reportProbe(report).catch((err: unknown) => {
        console.warn("[regions] probe telemetry failed", err)
      })
    },
    getNetworkType: readNetworkType,
  })
}
