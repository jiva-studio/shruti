import { loadWeeklyDigest, type WeeklyDigest } from "@usecases/activity/loadWeeklyDigest.js"
import { useShruti } from "@shruti/shruti.js"

export interface ActivityUseCases {
  loadWeeklyDigest(input: { fromMs: number; toMs: number; nowMs: number }): Promise<WeeklyDigest>
}

/** The listening-activity use cases, bound to the repositories, which are
 *  resolved per call and so throw until the databases are open. */
export function useActivityUseCases(): ActivityUseCases {
  const app = useShruti()
  return {
    loadWeeklyDigest: (input) => loadWeeklyDigest(input, app.repositories()),
  }
}
