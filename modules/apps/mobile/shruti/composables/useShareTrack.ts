import { useI18n } from "vue-i18n"
import { actionSheetController, loadingController } from "@ionic/vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { RenderTranscriptRequest, ShareOptions } from "@ports/app/index.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { WEB_APP_BASE_URL, WEB_APP_DEFAULT_LOCALE, WEB_APP_LOCALES } from "@lib/domain/servers.js"
import {
  preferredContentLanguage,
  resolveLocalizedName,
  resolveTrackTitle,
} from "@lib/domain/services/localizedName.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { useShruti } from "@shruti/shruti.js"
import { useAppLanguage } from "@shruti/composables/useAppLanguage.js"
import { useLibraryLanguages } from "@shruti/composables/useLibraryLanguages.js"
import { useOverlaysStore } from "@shruti/stores/useOverlaysStore.js"
import { useDictionariesStore } from "@shruti/stores/useDictionariesStore.js"
import { useDownloadStore } from "@shruti/stores/useDownloadStore.js"
import { usePurchasesStore } from "@shruti/stores/usePurchasesStore.js"
import { useTrackSheetStore } from "@shruti/stores/useTrackSheetStore.js"
import { useToast } from "@kit/composables"
import { useShareJobStore, type ShareJobKind } from "@shruti/stores/useShareJobStore.js"
import { useShareTranscript } from "./useShareTranscript.js"

export interface UseShareTrackReturn {
  /** Open the per-track Share sub-menu (PDF / text / audio). */
  presentShareMenu: (trackId: TrackId) => Promise<void>
}

type ShareReason = "no_transcript" | "no_audio" | "error"
type Produced =
  | { readonly ok: true; readonly options: ShareOptions }
  | { readonly ok: false; readonly reason: ShareReason }

// The web route param is the track id without the `track_` prefix it strips.
const TRACK_ID_PREFIX = /^track_/

/**
 * Flatten transcript blocks into readable plain text: one line per
 * sentence / verse, a blank line at paragraph boundaries.
 */
function transcriptToText(transcript: Transcript): string {
  const out: string[] = []
  for (const block of transcript.blocks) {
    switch (block.type) {
      case "paragraph":
        if (out.length > 0 && out[out.length - 1] !== "") out.push("")
        break
      case "sentence":
      case "verse:translation": {
        const line = block.text.trim()
        if (line) out.push(line)
        break
      }
      case "verse:text": {
        const line = block.text.join(" ").trim()
        if (line) out.push(line)
        break
      }
    }
  }
  return out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

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
  const shareJob = useShareJobStore()
  const dicts = useDictionariesStore()
  const purchases = usePurchasesStore()
  const trackSheet = useTrackSheetStore()
  const shareTranscript = useShareTranscript()

  /** Assemble the share-transcript cover fields from the local DB +
   *  dictionaries — the same set the chat tool sends, so a Library PDF and
   *  a chat PDF of the same lecture have an identical cover. All optional;
   *  the renderer degrades gracefully. */
  async function resolveCover(
    trackId: TrackId,
    lang: LanguageCode
  ): Promise<
    Pick<
      RenderTranscriptRequest,
      "title" | "author" | "date" | "location" | "references" | "tags" | "outline"
    >
  > {
    const track = await app.repositories().tracks.getById(trackId)
    if (!track) {
      return {
        title: null,
        author: null,
        date: null,
        location: null,
        references: [],
        tags: [],
        outline: null,
      }
    }
    const references = track.references.map((r) => {
      const src = r.sourceId ? dicts.sourcesById.get(r.sourceId) : undefined
      const name = src ? (src.names.get(lang) ?? [...src.names.values()][0]) : undefined
      const tokens = r.tokens.join(".")
      return {
        shortName: name?.shortName ?? null,
        fullName: name?.fullName ?? null,
        sourceId: r.sourceId,
        tokens: tokens || null,
      }
    })
    const tags = track.tagIds
      .map((id) => resolveLocalizedName(dicts.tagsById.get(id), lang))
      .filter((t): t is string => Boolean(t))
    return {
      title: resolveTrackTitle(track, lang) ?? null,
      author: track.authorId
        ? (resolveLocalizedName(dicts.authorsById.get(track.authorId), lang) ?? null)
        : null,
      date: track.date || null,
      location: track.locationId
        ? (resolveLocalizedName(dicts.locationsById.get(track.locationId), lang) ?? null)
        : null,
      references,
      tags,
      outline: track.variants.find((v) => v.language === lang)?.outline ?? null,
    }
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

  async function run(
    kind: ShareJobKind,
    jobKey: string,
    label: string,
    produce: (ctx: { setLabel: (message: string) => void }) => Promise<Produced>
  ): Promise<void> {
    // Single long-running share at a time — shared with the audio/video/
    // chat-PDF jobs.
    if (!shareJob.tryStart(kind, jobKey)) {
      await toast.info(t("notes.shareAlreadyInProgress"))
      return
    }

    const modal = await loadingController.create({ message: label, spinner: "crescent" })
    await modal.present()
    let dismissed = false
    const close = async (): Promise<void> => {
      if (dismissed) return
      dismissed = true
      await modal.dismiss()
    }

    try {
      const result = await produce({
        setLabel: (message) => {
          modal.message = message
        },
      })
      if (!result.ok) {
        await close()
        await toast.error(
          result.reason === "no_transcript"
            ? t("search.share.noTranscript")
            : result.reason === "no_audio"
              ? t("search.share.noAudio")
              : t("search.share.error")
        )
        return
      }
      // Drop the spinner before the share sheet so they don't overlap.
      await close()
      await app.shareService.share(result.options)
    } catch (err) {
      console.warn("[share-track] failed", err)
      await close()
      await toast.error(t("search.share.error"))
    } finally {
      await close()
      shareJob.finish()
    }
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
    return run("audio", `audio:${trackId}`, t("search.share.preparingAudio"), async (ctx) => {
      const repos = app.repositories()
      const track = await repos.tracks.getById(trackId)
      const variant = track ? pickPlayableVariant(track) : null
      if (!track || !variant?.audio) return { ok: false, reason: "no_audio" }

      const url = app.storagePublicUrl.get(variant.audio.path)
      // Reuse an offline / previously-shared copy when present (same
      // native cache keyed by URL); otherwise download with progress.
      const localUri =
        (await app.mediaDownloader.resolveLocalUrl(url).catch(() => null)) ??
        (await app.mediaDownloader.download(url, (received, total) => {
          if (total > 0) {
            ctx.setLabel(
              t("search.share.preparingAudioPct", {
                pct: Math.min(100, Math.round((received / total) * 100)),
              })
            )
          }
        }))
      // The bytes landed in durable app storage under the same key an offline
      // save uses, so the lecture IS downloaded now — register it as one.
      // Without this the file is invisible to everything that rebuilds from
      // `media_items`: it is not charged to the storage budget, shows no
      // offline badge after a relaunch, and archiving never reclaims it, so it
      // survives until uninstall (#1739).
      await useDownloadStore().adoptCachedFile(trackId, localUri, variant.audio.filesize)

      const lang =
        preferredContentLanguage(track, libraryLanguages.value, appLanguage.value) ??
        appLanguage.value
      const title = resolveTrackTitle(track, lang) ?? trackId
      return {
        ok: true,
        options: { url: localUri, title, dialogTitle: t("search.share.dialogAudio") },
      }
    })
  }

  return { presentShareMenu }
}
