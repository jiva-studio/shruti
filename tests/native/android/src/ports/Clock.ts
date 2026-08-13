export interface ClockSnapshot {
  /** Device wall clock at the moment of the reading. */
  readonly at: Date
  /** Olson id, e.g. "Europe/Moscow". */
  readonly timeZone: string
  /** Runner-side reading time, so `restore` can add the real time since. */
  readonly takenAtHostMs: number
}

/**
 * The device's own wall clock. Every setter needs root, which the adapter
 * takes and drops again — a spec must hand back what `snapshot` gave it, or
 * the emulator stays on a fake date and every later spec dates its data wrong.
 */
export interface Clock {
  snapshot(): Promise<ClockSnapshot>
  /** Local calendar date the device is on, "YYYY-MM-DD". */
  today(): Promise<string>
  /** The next local-midnight rollover the device will see. */
  nextMidnight(): Promise<Date>
  set(at: Date): Promise<void>
  setTimeZone(id: string): Promise<void>
  restore(snapshot: ClockSnapshot): Promise<void>
}
