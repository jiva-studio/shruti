export interface RecordedRequest {
  readonly method: string
  readonly path: string
}

/** The fake server the app talks to. Lets a test dictate server-side state. */
export interface Backend {
  reset(): Promise<void>
  seed(state: { changes?: unknown[]; cursor?: number; user?: Record<string, unknown> }): Promise<void>
  requests(): Promise<RecordedRequest[]>
  unhandled(): Promise<RecordedRequest[]>
}
