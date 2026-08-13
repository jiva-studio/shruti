export interface ListeningSession {
  readonly id: string
  readonly itemId: string
  /** Unix seconds. */
  readonly startedAt: number
  /** Unix seconds; the day this lands on is the day the row is credited to. */
  readonly endedAt: number
  /** Seconds from the start of the track. */
  readonly fromPosition: number
  readonly toPosition: number
}

export interface DailyTotal {
  /** "YYYY-MM-DD" in the device's local timezone. */
  readonly date: string
  readonly listenedSeconds: number
}

/** The journal the app writes while playing, read off the device's database. */
export interface ListeningJournal {
  sessions(): Promise<readonly ListeningSession[]>
  /** Per local day, bucketed and de-duplicated the way the heatmap does it. */
  dailyTotals(): Promise<readonly DailyTotal[]>
}
