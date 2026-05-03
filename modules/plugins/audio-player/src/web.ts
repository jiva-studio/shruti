import type { PluginListenerHandle } from "@capacitor/core"

import type { AudioPlayerPlugin, OpenParams, AudioPlayerListenerResult, Status } from "./definitions"


/**
 * Browser implementation of the audio-player plugin.
 *
 * Reuses a single `HTMLAudioElement` for the lifetime of the page.
 * Reassigning `src` instead of constructing a new Audio() per open()
 * is what guarantees only one stream plays at a time — a fresh
 * `new Audio(url)` whose previous reference was dropped will keep
 * playing in the background until garbage collection eventually
 * collects it, which produces the "two tracks at once" bug.
 *
 * `seek()` calls that arrive before `loadedmetadata` are queued and
 * applied as soon as the metadata is known. Some browsers silently
 * drop a `currentTime = X` assignment made on an unloaded media
 * element, which produced "track restarts from zero on resume".
 */
export class AudioPlayerPluginWeb implements AudioPlayerPlugin {
  private readonly audio: HTMLAudioElement = new Audio()
  private callback: ((status: Status) => void) | null = null
  private currentItemId: string | null = null
  private pendingSeekSec: number | null = null
  private intervalId: ReturnType<typeof setInterval> | null = null


  constructor () {
    this.audio.preload = "metadata"

    this.audio.addEventListener("loadedmetadata", () => {
      if (this.pendingSeekSec !== null) {
        this.audio.currentTime = this.pendingSeekSec
        this.pendingSeekSec = null
      }
    })
  }

  /** Idempotent. Started lazily on first `onProgressChanged()` so a
   *  page that never registers a listener doesn't burn a 1Hz timer. */
  private startProgressTimer(): void {
    if (this.intervalId !== null) return
    this.intervalId = setInterval(() => {
      if (!this.callback) return
      this.callback({
        position: this.audio.currentTime,
        playing: !this.audio.paused,
        duration: isFinite(this.audio.duration) ? this.audio.duration : 0,
        itemId: this.currentItemId || "",
      })
    }, 1000)
  }

  /** For tests / HMR teardown. The plugin is a singleton in production
   *  so this is rarely called from app code. */
  destroy(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
    this.audio.pause()
    this.callback = null
    this.currentItemId = null
    this.pendingSeekSec = null
  }


  async open(
    params: OpenParams
  ): Promise<void> {
    // Stop whatever is playing on the shared audio element before
    // pointing it at a new source. Without an explicit pause + src
    // reset a fast switch can leave the engine mid-fetch on the
    // previous URL.
    this.audio.pause()
    this.pendingSeekSec = null
    this.audio.removeAttribute("src")
    this.audio.load()
    this.audio.src = params.url
    this.audio.load()
    this.currentItemId = params.itemId
  }

  async play(): Promise<void> {
    await this.audio.play();
  }

  async togglePause(): Promise<void> {
    if (this.audio.paused) {
      await this.audio.play();
    } else {
      this.audio.pause();
    }
  }

  async seek(
    options: { position: number }
  ): Promise<void> {
    // readyState >= HAVE_METADATA (1) means duration is known and the
    // assignment will stick. Otherwise queue it for the loadedmetadata
    // handler.
    if (this.audio.readyState >= 1) {
      this.audio.currentTime = options.position
    } else {
      this.pendingSeekSec = options.position
    }
  }

  async stop(): Promise<void> {
    this.audio.pause();
    this.pendingSeekSec = null
    this.audio.removeAttribute("src")
    this.audio.load()
    this.currentItemId = null;
  }

  onProgressChanged(
    callback: (status: Status) => void
  ): Promise<AudioPlayerListenerResult> {
    this.callback = callback;
    this.startProgressTimer();
    return new Promise((resolve, _reject) => {
      resolve({ callbackId: "123" });
    });
  }

  addListener(_eventName: string, _listenerFunc: (...args: any[]) => any): Promise<PluginListenerHandle> {
    throw new Error("Method not implemented.");
  }

  removeAllListeners(): Promise<void> {
    throw new Error("Method not implemented.");
  }
}
