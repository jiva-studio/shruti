import type { PluginListenerHandle } from "@capacitor/core"

import type {
  AudioPlayerPlugin,
  OpenParams,
  AudioPlayerListenerResult,
  SeekByParams,
  SetMixParams,
  SetPlaybackRateParams,
  SetProgressIntervalParams,
  Status,
} from "./definitions"


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
  /** Progress emit cadence. Adjusted by `setProgressInterval()` so the
   *  page can stream fast while a transcript is visible and slow down (or
   *  go to a heartbeat) when only a progress ring is shown / backgrounded. */
  private intervalMs = 1000
  /** Tracks the last emitted playing-state so we send one final frame on
   *  the pause/stop edge and then stay quiet — no point streaming an
   *  unchanging position once playback has stopped (incl. track end). */
  private wasPlaying = false

  // Web Audio graph for stereo→mono blending. Built lazily on first
  // setMix() — pages that never use the feature don't pay for an
  // AudioContext (and don't trigger Safari's autoplay-suspended state
  // for media that would otherwise have played fine).
  private audioCtx: AudioContext | null = null
  private mediaSource: MediaElementAudioSourceNode | null = null
  private splitter: ChannelSplitterNode | null = null
  private leftGain: GainNode | null = null
  private rightGain: GainNode | null = null
  private sumGain: GainNode | null = null
  private mixActive = false


  constructor () {
    this.audio.preload = "metadata"
    this.audio.crossOrigin = "anonymous"
    // Preserve pitch when playbackRate ≠ 1 — defaults to true in modern
    // browsers but Safari < 15 used the webkit-prefixed name. Set both
    // so a 2× lecture still sounds like a human, not a chipmunk.
    this.audio.preservesPitch = true
    ;(this.audio as unknown as { mozPreservesPitch?: boolean }).mozPreservesPitch = true
    ;(this.audio as unknown as { webkitPreservesPitch?: boolean }).webkitPreservesPitch = true

    this.audio.addEventListener("loadedmetadata", () => {
      if (this.pendingSeekSec !== null) {
        this.audio.currentTime = this.pendingSeekSec
        this.pendingSeekSec = null
      }
    })
  }

  /** Idempotent. Started lazily on first `onProgressChanged()` so a
   *  page that never registers a listener doesn't burn a timer. */
  private startProgressTimer(): void {
    if (this.intervalId !== null) return
    this.intervalId = setInterval(() => this.emitProgress(), this.intervalMs)
  }

  private emitProgress(): void {
    if (!this.callback) return
    const playing = !this.audio.paused
    // While playing, emit every tick. Once stopped (pause / track end),
    // emit exactly one final frame and then go quiet until playback
    // resumes — the native engines behave the same way.
    if (!playing && !this.wasPlaying) return
    this.wasPlaying = playing
    this.callback({
      position: this.audio.currentTime,
      playing,
      duration: isFinite(this.audio.duration) ? this.audio.duration : 0,
      itemId: this.currentItemId || "",
    })
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
    // play() is always invoked from a user gesture (a tap on the play
    // button), so it's the right place to lift the AudioContext out of
    // its initial 'suspended' state on Safari / Chrome autoplay-policy.
    if (this.audioCtx && this.audioCtx.state === "suspended") {
      await this.audioCtx.resume()
    }
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

  async seekBy(options: SeekByParams): Promise<void> {
    if (this.audio.readyState < 1) {
      // No metadata yet — fall through to absolute seek when it loads.
      const base = this.pendingSeekSec ?? 0
      this.pendingSeekSec = Math.max(0, base + options.delta)
      return
    }
    const next = this.audio.currentTime + options.delta
    const dur = this.audio.duration
    const upper = Number.isFinite(dur) ? dur : Number.POSITIVE_INFINITY
    this.audio.currentTime = Math.min(upper, Math.max(0, next))
  }

  async setPlaybackRate(params: SetPlaybackRateParams): Promise<void> {
    let rate = params.rate
    if (!Number.isFinite(rate)) rate = 1
    if (rate < 0.25) rate = 0.25
    if (rate > 4) rate = 4
    this.audio.playbackRate = rate
  }

  async setProgressInterval(params: SetProgressIntervalParams): Promise<void> {
    let next = Math.floor(params.intervalMs)
    if (!Number.isFinite(next) || next <= 0) next = 1000
    if (next < 250) next = 250
    if (next === this.intervalMs) return
    this.intervalMs = next
    // Restart the timer at the new cadence if one is already running.
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
      this.startProgressTimer()
    }
  }

  /**
   * Toggle and tune the stereo→mono blending graph. See `SetMixParams`
   * in definitions.ts for the contract. The graph is:
   *
   *   audio (HTMLMediaElement)
   *      └─ MediaElementAudioSource
   *            ├─ (passthrough)  → destination          // when enabled=false
   *            └─ ChannelSplitter(2)                    // when enabled=true
   *                  ├─ ch0 → leftGain  ((1−s)·k) ─┐
   *                  └─ ch1 → rightGain (   s ·k) ─┴─ sumGain → destination
   *
   * Both gains carry the loudness-compensation factor
   * `k = 1 / sqrt((1−s)² + s²)` — a single sumGain on the mono branch
   * would also work, but baking it into the per-channel gains keeps
   * the graph minimal and means we never need to retune sumGain.
   *
   * `MediaElementAudioSource` is created exactly once per <audio>
   * element. Calling `createMediaElementSource` twice on the same
   * element throws InvalidStateError, so the graph is set up the
   * first time setMix() runs and reused for the lifetime of the page.
   */
  async setMix(params: SetMixParams): Promise<void> {
    const ratio = clamp01(params.ratio)
    const enabled = params.enabled

    if (!enabled && !this.audioCtx) {
      // Nothing to do — graph never built, audio is going straight to
      // the speakers via the default media-element route.
      return
    }

    this.ensureGraph()
    if (!this.audioCtx || !this.leftGain || !this.rightGain || !this.sumGain || !this.mediaSource) return

    const ctx = this.audioCtx
    const now = ctx.currentTime
    const TC = 0.01 // ~30 ms exponential ramp via setTargetAtTime

    if (enabled) {
      // Compute per-channel weights with constant-loudness compensation.
      const lw = (1 - ratio)
      const rw = ratio
      const k = 1 / Math.sqrt(lw * lw + rw * rw)
      this.leftGain.gain.setTargetAtTime(lw * k, now, TC)
      this.rightGain.gain.setTargetAtTime(rw * k, now, TC)

      if (!this.mixActive) {
        // Switch the graph from passthrough to mix. disconnect() removes
        // the direct source→destination edge; the splitter chain is
        // already wired and was just sitting there with zero gain.
        try { this.mediaSource.disconnect(ctx.destination) } catch { /* not connected */ }
        this.sumGain.connect(ctx.destination)
        this.mixActive = true
      }
    } else {
      // Switch back to passthrough. Mute the mix branch first so the
      // disconnect doesn't pop, then reconnect the direct edge.
      this.leftGain.gain.setTargetAtTime(0, now, TC)
      this.rightGain.gain.setTargetAtTime(0, now, TC)

      if (this.mixActive) {
        try { this.sumGain.disconnect(ctx.destination) } catch { /* not connected */ }
        this.mediaSource.connect(ctx.destination)
        this.mixActive = false
      }
    }
  }

  private ensureGraph(): void {
    if (this.audioCtx) return
    const Ctor: typeof AudioContext | undefined =
      typeof AudioContext !== "undefined" ? AudioContext :
      // Safari < 14.1 still ships the prefixed name.
      (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctor) return
    const ctx = new Ctor()
    this.audioCtx = ctx
    this.mediaSource = ctx.createMediaElementSource(this.audio)
    this.splitter = ctx.createChannelSplitter(2)
    this.leftGain = ctx.createGain()
    this.rightGain = ctx.createGain()
    this.sumGain = ctx.createGain()

    // Start in passthrough so audio that was already audible before
    // setMix({enabled:true}) keeps playing without a gap.
    this.leftGain.gain.value = 0
    this.rightGain.gain.value = 0
    this.sumGain.gain.value = 1

    this.mediaSource.connect(this.splitter)
    this.splitter.connect(this.leftGain, 0)
    this.splitter.connect(this.rightGain, 1)
    this.leftGain.connect(this.sumGain)
    this.rightGain.connect(this.sumGain)
    // sumGain is *not* connected to destination yet; the passthrough
    // edge is what's audible. setMix(enabled:true) flips this.
    this.mediaSource.connect(ctx.destination)
    this.mixActive = false
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

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0
  if (x < 0) return 0
  if (x > 1) return 1
  return x
}
