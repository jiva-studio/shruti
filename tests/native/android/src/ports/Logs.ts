export interface Logs {
  clear(): Promise<void>
  errorLines(): Promise<string[]>
  /** Log lines matching `pattern`, at any level — not every failure is logged as one. */
  linesMatching(pattern: RegExp): Promise<string[]>
}
