import { defineStore } from "pinia"
import { computed, ref } from "vue"
import type { TrackId } from "@lib/domain/core.js"
import { useConfig } from "@lectorium/composables/useConfig.js"
import { useLectorium } from "@lectorium/lectorium.js"

/** Config key for the offline-storage budget, in bytes. `0` = unlimited. */
export const DOWNLOAD_LIMIT_KEY = "settings.downloadLimitBytes"

const GIB = 1024 * 1024 * 1024

/**
 * Budget presets offered in Settings, in bytes. `0` is "no limit" and
 * restores the pre-budget behaviour (download everything that's queued).
 */
export const DOWNLOAD_LIMIT_PRESETS = [0, 1 * GIB, 2 * GIB, 4 * GIB, 8 * GIB, 16 * GIB, 32 * GIB]

/**
 * Default budget. A whole seminar or a long playlist can queue 100+
 * lectures at ~34 MB each (~3.4 GB), which is how a device runs out of
 * space without ever being told. 8 GB ≈ 240 lectures — far past normal
 * use, but bounded.
 */
export const DEFAULT_DOWNLOAD_LIMIT_BYTES = 8 * GIB

/**
 * Assumed size for a track the catalog has no `filesize` for (personal
 * library imports, a row that predates the column). Close to the corpus
 * average, and deliberately not 0 — an unknown size must still consume
 * budget, or the cap leaks.
 */
export const ESTIMATED_AUDIO_BYTES = 40 * 1024 * 1024

/**
 * How much of the offline-storage budget the downloaded audio occupies.
 *
 * Sizes are read from the catalog's `track_audio.filesize` for the audio
 * version the app actually downloads (clean over original) — NOT from the
 * legacy `track_variants.audio_filesize`, which carries the original
 * file's size and is wrong for nearly every denoised track.
 *
 * `usedBytes` is what is on disk per the user DB; `reservedBytes` covers
 * transfers that have been started but haven't landed yet, so a draining
 * prefetch queue can't over-commit the budget between two refreshes.
 */
export const useDownloadQuotaStore = defineStore("downloadQuota", () => {
  const app = useLectorium()
  const limitBytes = useConfig<number>(DOWNLOAD_LIMIT_KEY, DEFAULT_DOWNLOAD_LIMIT_BYTES)

  const usedBytes = ref(0)
  // Until the first successful measurement `usedBytes` is a placeholder 0,
  // which would wave through a whole playlist on a cold start. Callers that
  // are about to spend budget await `ensureMeasured()` first.
  let measured = false
  let measuring: Promise<void> | null = null
  const reservations = ref<Map<TrackId, number>>(new Map())
  const reservedBytes = computed(() => {
    let total = 0
    for (const bytes of reservations.value.values()) total += bytes
    return total
  })
  const committedBytes = computed(() => usedBytes.value + reservedBytes.value)
  const unlimited = computed(() => limitBytes.value <= 0)

  function sizeOf(filesize: number | null | undefined): number {
    return typeof filesize === "number" && filesize > 0 ? filesize : ESTIMATED_AUDIO_BYTES
  }

  /**
   * `exceptTrackId` discounts that track's own reservation. A caller that
   * reserves up front (the prefetch drain) would otherwise be billed twice
   * when the download path re-checks the budget for the same track, making
   * the effective test `used + 2·size <= limit`.
   */
  function hasRoomFor(bytes: number, exceptTrackId?: TrackId): boolean {
    if (unlimited.value) return true
    const own = exceptTrackId === undefined ? 0 : (reservations.value.get(exceptTrackId) ?? 0)
    return committedBytes.value - own + bytes <= limitBytes.value
  }

  /**
   * Recompute `usedBytes` from the user DB's ready media rows joined with
   * the catalog's sizes. Cheap enough to run on hydrate and after each
   * eviction; the incremental `settle`/`forget` updates keep it accurate
   * in between.
   */
  async function refresh(): Promise<void> {
    try {
      // `repositories()` throws until the user + content DBs are open.
      const repos = app.repositories()
      const ready = await repos.mediaItems.listReady()
      // One row per (track, kind), but only one version is ever fetched —
      // de-dupe so a track with both rows isn't counted twice.
      const trackIds = [...new Set(ready.map((item) => item.trackId))]
      const sizes = await repos.tracks.getAudioSizesBytes(trackIds)
      let total = 0
      for (const trackId of trackIds) total += sizeOf(sizes.get(trackId))
      usedBytes.value = total
      measured = true
    } catch (err) {
      // The DBs may simply not be open yet (App mounts before the welcome
      // flow opens them). Leave `measured` false so the next spender
      // re-measures instead of budgeting against a placeholder zero.
      console.warn("[downloads] storage usage refresh failed:", err)
    }
  }

  /**
   * Measure once before the first budget decision of the session.
   * Concurrent callers share the one in-flight measurement.
   */
  async function ensureMeasured(): Promise<void> {
    if (measured) return
    measuring ??= refresh().finally(() => {
      measuring = null
    })
    await measuring
  }

  function reserve(trackId: TrackId, bytes: number): void {
    const next = new Map(reservations.value)
    next.set(trackId, bytes)
    reservations.value = next
  }

  /** Drop a reservation, promoting it into `usedBytes` when bytes landed. */
  function settle(trackId: TrackId, stored: boolean): void {
    const bytes = reservations.value.get(trackId)
    if (bytes === undefined) return
    const next = new Map(reservations.value)
    next.delete(trackId)
    reservations.value = next
    if (stored) usedBytes.value += bytes
  }

  /** Give back the budget an evicted track held. */
  function forget(trackId: TrackId, bytes: number): void {
    settle(trackId, false)
    usedBytes.value = Math.max(0, usedBytes.value - bytes)
  }

  function reset(): void {
    usedBytes.value = 0
    reservations.value = new Map()
    measured = false
  }

  return {
    limitBytes,
    usedBytes,
    reservedBytes,
    committedBytes,
    unlimited,
    hasRoomFor,
    sizeOf,
    refresh,
    ensureMeasured,
    reserve,
    settle,
    forget,
    reset,
  }
})
