import { useI18n } from "vue-i18n"
import { actionSheetController } from "@ionic/vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { WEB_APP_BASE_URL, WEB_APP_DEFAULT_LOCALE, WEB_APP_LOCALES } from "@lib/domain/servers.js"
import { preferredContentLanguage, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"
import { useToast } from "@kit/composables"
import { useShareJobRunner } from "@shruti/composables/useShareJobRunner.js"
import { useShareAudioArtifact } from "@shruti/composables/useShareAudioArtifact.js"
import { useShareTranscript } from "./useShareTranscript.js"
import { buildShareCover, type ShareCover } from "@shruti/composables/shareCover.js"
import { transcriptToText } from "@shruti/composables/transcriptToText.js"

export interface UseShareTrackReturn {
  /** Open the per-track Share sub-menu (PDF / text / audio). */
  presentShareMenu: (trackId: TrackId) => Promise<void>
}

// The web route param is the track id without the `track_` prefix it strips.
const TRACK_ID_PREFIX = /^track_/

/**
 * Per-track "Share" sub-menu for the Library track sheet. Offers the
 * transcript as a PDF, the transcript as plain text, and the audio file
 * — each handed to the native share sheet. PDF + audio are downloaded to
 * a local file first (reusing an offline copy when present); text is
 * shared as a string. All three share the single-slot share-job guard and
 * a blocking spinner for the prepare step.
 */
export function useShareTrack(): UseShareTrackReturn {
  const { t } = useI18n()
  const app = useShruti()
  const appLanguage = useAppLanguage()
  const libraryLanguages = useLibraryLanguages()
  const overlays = useOverlaysStore()
  const toast = useToast()
  const run = useShareJobRunner()
  const produceAudioArtifact = useShareAudioArtifact()
  const dicts = useDictionariesStore()
  const purchases = usePurchasesStore()
  const trackSheet = useTrackSheetStore()
  const shareTranscript = useShareTranscript()

  async function resolveCover(trackId: TrackId, lang: LanguageCode): Promise<ShareCover> {
    const track = await app.repositories().tracks.getById(trackId)
    return buildShareCover(track, dicts, lang)
  }

  // Share in the user's content language: a library language actually available
  // for this track, else the first available — so a Russian lecture is shared in
  // Russian even on an English UI, while a single-language track shares the one
  // language it has. When several library languages are available, break the tie
  // by the UI language (mirrors preferredContentLanguage).
  function pickShareLang(available: readonly LanguageCode[]): LanguageCode {
    const candidates = libraryLanguages.value.filter((l) => available.includes(l))
    if (candidates.length === 0) return available[0] as LanguageCode
    if (candidates.includes(appLanguage.value as LanguageCode)) {
      return appLanguage.value as LanguageCode
    }
    return candidates[0] as LanguageCode
  }

  async function presentShareMenu(trackId: TrackId): Promise<void> {
    void app.haptics.impact("light")

    // Resolve availability up front so each row renders in its final
    // enabled/disabled state — Ionic's controller can't mutate buttons
    // after create.
    let hasTranscript: boolean
    let hasAudio: boolean
    try {
      const langs = await app.repositories().transcripts.availableLanguages(trackId)
      hasTranscript = langs.length > 0
    } catch {
      hasTranscript = true
    }
    try {
      const track = await app.repositories().tracks.getById(trackId)
      hasAudio = Boolean(track && pickPlayableVariant(track)?.audio)
    } catch {
      hasAudio = true
    }

    const sheet = await actionSheetController.create({
      header: t("search.share.title"),
      buttons: [
        {
          id: "share-link",
          text: t("search.share.link"),
          handler: () => {
            void shareLink(trackId)
          },
        },
        {
          id: "share-pdf",
          text: t("search.share.pdf"),
          // PDF export is the one Pro-gated format; the rest are free. The
          // badge waits for the FINAL answer — Ionic can't restyle a button
          // after create, so an unresolved store must render neutral rather
          // than label a subscriber's row "Pro" (#1839).
          cssClass: purchases.resolved && !purchases.isSubscribed ? "action-sheet-pro" : undefined,
          disabled: !hasTranscript,
          handler: () => {
            // The buttons are built synchronously and can't await, so the
            // gate runs here. Get the track sheet out of the paywall's way
            // up front — after `ensurePro` resolves, the route push has
            // already happened.
            if (!purchases.isSubscribed) trackSheet.close()
            void (async () => {
              if (!(await purchases.ensurePro("shareTranscript"))) return
              await shareTranscriptPdf(trackId)
            })()
          },
        },
        {
          id: "share-text",
          text: t("search.share.text"),
          disabled: !hasTranscript,
          handler: () => {
            void shareTranscriptText(trackId)
          },
        },
        {
          id: "share-audio",
          text: t("search.share.audio"),
          disabled: !hasAudio,
          handler: () => {
            void shareAudio(trackId)
          },
        },
        {
          text: t("app.close"),
          role: "cancel",
        },
      ],
    })
    overlays.actionSheetOpen = true
    void sheet.onDidDismiss().then(() => {
      overlays.actionSheetOpen = false
    })
    await sheet.present()
  }

  // Share the public web deep-link to the lecture. The page opens in the
  // user's app UI language (the web locale is its URL prefix; `sr-Latn` →
  // `sr-latn`), falling back to the web default for a UI language the web
  // doesn't serve. The share title still follows the lecture's content
  // language so it reads in the language the lecture is actually in.
  async function shareLink(trackId: TrackId): Promise<void> {
    void app.haptics.impact("light")
    try {
      const uiLocale = appLanguage.value.toLowerCase()
      const webLang = WEB_APP_LOCALES.includes(uiLocale) ? uiLocale : WEB_APP_DEFAULT_LOCALE
      const slug = trackId.replace(TRACK_ID_PREFIX, "")
      const track = await app.repositories().tracks.getById(trackId)
      const contentLang = track
        ? (preferredContentLanguage(track, libraryLanguages.value, appLanguage.value) ??
          appLanguage.value)
        : appLanguage.value
      const title = track ? (resolveTrackTitle(track, contentLang) ?? trackId) : trackId
      await app.shareService.share({
        url: `${WEB_APP_BASE_URL}/${webLang}/app/${slug}`,
        title,
        dialogTitle: t("search.share.dialogLink"),
      })
    } catch (err) {
      console.warn("[share-track] link failed", err)
      await toast.error(t("search.share.error"))
    }
  }

  function shareTranscriptPdf(trackId: TrackId): Promise<void> {
    return run("pdf", `pdf:${trackId}`, t("search.share.preparingPdf"), async () => {
      const repos = app.repositories()
      const langs = await repos.transcripts.availableLanguages(trackId)
      if (langs.length === 0) return { ok: false, reason: "no_transcript" }
      const lang = pickShareLang(langs)
      const transcriptKey = await repos.tracks.getTranscriptPath(trackId, lang)
      if (!transcriptKey) return { ok: false, reason: "no_transcript" }

      const cover = await resolveCover(trackId, lang)
      const title = cover.title ?? trackId
      const localUri = await shareTranscript.prepareLocalPdf({
        trackId,
        lang,
        transcriptKey,
        ...cover,
      })
      return {
        ok: true,
        options: { url: localUri, title, dialogTitle: t("search.share.dialogPdf") },
      }
    })
  }

  function shareTranscriptText(trackId: TrackId): Promise<void> {
    return run("pdf", `text:${trackId}`, t("search.share.preparingText"), async () => {
      const repos = app.repositories()
      const langs = await repos.transcripts.availableLanguages(trackId)
      if (langs.length === 0) return { ok: false, reason: "no_transcript" }
      const chosen = pickShareLang(langs)
      const transcript = await repos.transcripts.get(trackId, chosen)
      const body = transcriptToText(transcript)
      if (!body) return { ok: false, reason: "no_transcript" }

      const track = await repos.tracks.getById(trackId)
      const title = resolveTrackTitle(track, chosen) ?? trackId
      const header = track?.date ? `${title} (${track.date})` : title
      return {
        ok: true,
        options: {
          text: `${header}\n\n${body}`,
          title,
          dialogTitle: t("search.share.dialogText"),
        },
      }
    })
  }

  function shareAudio(trackId: TrackId): Promise<void> {
    return run("audio", `audio:${trackId}`, t("search.share.preparingAudio"), (ctx) =>
      produceAudioArtifact(trackId, ctx)
    )
  }

  return { presentShareMenu }
}
