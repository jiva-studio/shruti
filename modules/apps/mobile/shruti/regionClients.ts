import { deriveProbeObjectPath, useHttpServerProber } from "@infra/servers/index.js"
import type { PublicUrlOf } from "@infra/shareArtifactUrl.js"
import {
  useHttpShareAudioService,
  type ShareAudioRequest,
} from "@infra/shareAudio/http/useHttpShareAudioService.js"
import {
  useHttpShareVideoService,
  type ShareVideoRequest,
} from "@infra/shareVideo/http/useHttpShareVideoService.js"
import {
  useHttpShareTranscriptService,
  type ShareTranscriptRequest,
} from "@infra/shareTranscript/http/useHttpShareTranscriptService.js"
import type {
  IPreferences,
  IServerProber,
  IShareAudioService,
  IShareTranscriptService,
  IShareVideoService,
} from "@ports/app/index.js"
import { useShruti } from "@shruti/shruti.js"
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

export interface ShareRequests {
  readonly shareAudioRequest: ShareAudioRequest
  readonly shareVideoRequest: ShareVideoRequest
  readonly shareTranscriptRequest: ShareTranscriptRequest
}

export interface ShareServices {
  readonly shareAudioService: IShareAudioService
  readonly shareVideoService: IShareVideoService
  readonly shareTranscriptService: IShareTranscriptService
}

/** The share-* clients over their region-failover transports, with artifact
 *  URLs built on the active region's storage. share-video carries a Bearer
 *  token for the per-user daily quota; the others are anonymous. */
export function createShareServices(requests: ShareRequests): ShareServices {
  const getAccessToken = (): Promise<string | null> => useShruti().auth.getAccessToken()
  const publicUrlOf: PublicUrlOf = (key) => useShruti().storagePublicUrl.get(key)
  return {
    shareAudioService: useHttpShareAudioService(requests.shareAudioRequest, publicUrlOf),
    shareVideoService: useHttpShareVideoService(
      requests.shareVideoRequest,
      getAccessToken,
      publicUrlOf
    ),
    shareTranscriptService: useHttpShareTranscriptService(
      requests.shareTranscriptRequest,
      publicUrlOf
    ),
  }
}
