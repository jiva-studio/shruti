import { isFallbackOnly, type CdnServer } from "@lib/domain/servers.js"

export interface ProbeCandidates {
  /** Raced first: the preferred region, then the rest in declared order. */
  readonly regular: CdnServer[]
  /** Checked only when no regular region delivered a config. */
  readonly fallback: CdnServer[]
}

/** Split and order the regions for one probe. */
export function orderProbeCandidates(
  servers: readonly CdnServer[],
  preferredId: string | undefined
): ProbeCandidates {
  const regular = servers.filter((s) => !isFallbackOnly(s))
  const preferred = regular.find((s) => s.id === preferredId)
  return {
    regular: preferred ? [preferred, ...regular.filter((s) => s !== preferred)] : regular,
    fallback: servers.filter(isFallbackOnly),
  }
}
