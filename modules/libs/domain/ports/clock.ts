/** The wall clock, as the application layer asks for it. */
export interface IClock {
  /** Unix time in milliseconds. */
  now(): number
}
