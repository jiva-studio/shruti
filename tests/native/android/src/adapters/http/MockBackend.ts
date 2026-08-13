import type {
  AnonymousMint,
  AudioFixture,
  Backend,
  RecordedRequest,
} from "../../ports/Backend.js"

export class MockBackend implements Backend {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, init)
    if (!response.ok) throw new Error(`mock ${path} → ${response.status}`)
    return (await response.json()) as T
  }

  async reset(): Promise<void> {
    await this.call("/__reset", { method: "POST" })
  }

  async seed(state: {
    changes?: unknown[]
    cursor?: number
    user?: Record<string, unknown>
  }): Promise<void> {
    await this.call("/__seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(state),
    })
  }

  async useAudioFixture(fixture: AudioFixture): Promise<void> {
    await this.call("/__audio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fixture }),
    })
  }

  async requests(): Promise<RecordedRequest[]> {
    return this.call("/__requests")
  }

  async unhandled(): Promise<RecordedRequest[]> {
    return this.call("/__unknown")
  }

  async anonymousMints(): Promise<AnonymousMint[]> {
    return this.call("/__mints")
  }
}
