export interface Logs {
  clear(): Promise<void>
  errorLines(): Promise<string[]>
}
