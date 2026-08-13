export interface RecordedRequest {
  readonly method: string
  readonly path: string
}

/** Which recording every audio request is answered with. */
export type AudioFixture = "default" | "short"

/** One `/auth/anonymous` call: the device the app claimed to be, and the user
 *  the server gave that device. */
export interface AnonymousMint {
  readonly deviceId: string
  readonly platform: string | null
  readonly userId: string
}

/** The fake server the app talks to. Lets a test dictate server-side state. */
export interface Backend {
  reset(): Promise<void>
  seed(state: { changes?: unknown[]; cursor?: number; user?: Record<string, unknown> }): Promise<void>
  useAudioFixture(fixture: AudioFixture): Promise<void>
  requests(): Promise<RecordedRequest[]>
  unhandled(): Promise<RecordedRequest[]>
  anonymousMints(): Promise<AnonymousMint[]>
}
