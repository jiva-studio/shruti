import { useI18n } from "vue-i18n"
import type { TrackId } from "@lib/domain/core.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import type { Produced } from "@shruti/composables/useShareJobRunner.js"

export type ProduceAudioArtifact = (
  trackId: TrackId,
  ctx: { setLabel: (message: string) => void }
) => Promise<Produced>

/**
 * The lecture's audio file, ready for the share sheet: an offline copy when
 * one exists, otherwise a fresh download.
 */
export function useShareAudioArtifact(): ProduceAudioArtifact {
  const { t } = useI18n()
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()

  /**
   * The only download path that doesn't go through `watchDownload` — it talks
   * to the `IMediaDownloader` port and has no task id to subscribe to — so it
   * carries its own stall guard, re-armed on every progress event.
   *
   * It aborts THIS attempt through the signal rather than cancelling the URL:
   * an offline save of the same lecture shares the destination, and the port's
   * cancel would delete its partial file too.
   */
  async function downloadWatched(url: string, onPercent: (pct: number) => void): Promise<string> {
    const abort = new AbortController()
    const stall = app.createStallGuard({
      label: "Share audio download",
      onStall: () => abort.abort(),
    })
    try {
      return await app.mediaDownloader.download(
        url,
        (received, total) => {
          stall.ping()
          if (total > 0) onPercent(Math.min(100, Math.round((received / total) * 100)))
        },
        abort.signal
      )
    } finally {
      stall.cancel()
    }
  }

  return async (trackId, ctx) => {
    const track = await app.repositories().tracks.getById(trackId)
    const variant = track ? pickPlayableVariant(track) : null
    if (!track || !variant?.audio) return { ok: false, reason: "no_audio" }

    const url = app.storagePublicUrl.get(variant.audio.path)
    // Reuse an offline / previously-shared copy when present (same native
    // cache keyed by URL); otherwise download with progress.
    const localUri =
      (await app.mediaDownloader.resolveLocalUrl(url).catch(() => null)) ??
      (await downloadWatched(url, (pct) => {
        ctx.setLabel(t("search.share.preparingAudioPct", { pct }))
      }))
    // The bytes landed in durable storage under the key an offline save uses,
    // so register them as a download — otherwise the file is invisible to
    // everything that rebuilds from `media_items` and survives until uninstall.
    await useDownloadStore().adoptCachedFile(trackId, localUri, variant.audio.filesize)

    const lang =
      preferredContentLanguage(track, libraryLanguages.value, appLanguage.value) ??
      appLanguage.value
    return {
      ok: true,
      options: {
        url: localUri,
        title: resolveTrackTitle(track, lang) ?? trackId,
        dialogTitle: t("search.share.dialogAudio"),
      },
    }
  }
}
