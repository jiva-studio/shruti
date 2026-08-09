import type { PlayTrackError } from "@usecases/playback/playTrack.js"

/**
 * i18n key for a refused `usePlayerStore.openTrack`.
 *
 * The two refusals are not interchangeable: `engine-failed` is transient
 * (bad URL, unreadable file) and worth retrying, while
 * `no-audio-available` means the catalogue holds no audio for the
 * lecture at all — telling that user to "check your connection and try
 * again" sends them round a loop that can never succeed.
 */
export function playbackErrorKey(error: PlayTrackError | "engine-failed"): string {
  return error === "no-audio-available" ? "errors.noAudioForLecture" : "errors.playbackFailed"
}
