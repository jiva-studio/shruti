import { useI18n } from "vue-i18n"
import { actionSheetController, loadingController } from "@ionic/vue"
import type { LanguageCode, TrackId } from "@lib/domain/core.js"
import type { RenderTranscriptRequest, ShareOptions } from "@ports/app/index.js"
import { pickPlayableVariant } from "@lib/domain/track.js"
import { resolveLocalizedName, resolveTrackTitle } from "@lib/domain/services/localizedName.js"
import type { Transcript } from "@lib/domain/transcript.js"
import { useLectorium } from "@lectorium/lectorium.js"
import { useAppLanguage } from "@lectorium/composables/useAppLanguage.js"
import { useOverlaysStore } from "@lectorium/stores/useOverlaysStore.js"
import { useDictionariesStore } from "@lectorium/stores/useDictionariesStore.js"
import { useToast } from "@kit/composables"
import { useShareJobStore, type ShareJobKind } from "@lectorium/stores/useShareJobStore.js"
import { useShareTranscript } from "./useShareTranscript.js"

export interface UseShareTrackReturn {
  /** Open the per-track Share sub-menu (PDF / text / audio). */
  presentShareMenu: (trackId: TrackId) => Promise<void>
}

type ShareReason = "no_transcript" | "no_audio" | "error"
type Produced =
  | { readonly ok: true; readonly options: ShareOptions }
  | { readonly ok: false; readonly reason: ShareReason }

// Filesystem-unsafe across Android / iOS / Windows share targets.
// eslint-disable-next-line no-control-regex
const BAD_FNAME = /[\\/:*?"<>|\x00-\x1f]/g

function safeBase(name: string, fallback: string): string {
  return name.replace(BAD_FNAME, "").trim().slice(0, 80) || fallback
}

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
  const app = useLectorium()
  const appLanguage = useAppLanguage()
  const overlays = useOverlaysStore()
  const toast = useToast()
  const shareJob = useShareJobStore()
  const dicts = useDictionariesStore()
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
      return { title: null, author: null, date: null, location: null, references: [], tags: [], outline: null }
    }
    const references = track.references.map((r) => {
      const src = dicts.sourcesById.get(r.sourceId)
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

  // The transcript endpoints only speak ru / en; for any other UI
  // language fall back to ru and let the server / repo pick what exists.
  function reqLang(): LanguageCode {
    return (appLanguage.value === "en" ? "en" : "ru") as LanguageCode
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
          text: t("search.share.pdf"),
          disabled: !hasTranscript,
          handler: () => {
            void shareTranscriptPdf(trackId)
          },
        },
        {
          text: t("search.share.text"),
          disabled: !hasTranscript,
          handler: () => {
            void shareTranscriptText(trackId)
          },
        },
        {
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

  function shareTranscriptPdf(trackId: TrackId): Promise<void> {
    return run("pdf", `pdf:${trackId}`, t("search.share.preparingPdf"), async () => {
      const repos = app.repositories()
      const langs = await repos.transcripts.availableLanguages(trackId)
      if (langs.length === 0) return { ok: false, reason: "no_transcript" }
      const lang = langs.includes(reqLang()) ? reqLang() : langs[0]
      const transcriptKey = await repos.tracks.getTranscriptPath(trackId, lang)
      if (!transcriptKey) return { ok: false, reason: "no_transcript" }

      const cover = await resolveCover(trackId, lang)
      const title = cover.title ?? trackId
      const filename = `${safeBase(title, trackId)}${cover.date ? ` (${cover.date})` : ""}.pdf`
      const localUri = await shareTranscript.prepareLocalPdf(
        { trackId, lang, transcriptKey, ...cover },
        filename
      )
      return {
        ok: true,
        options: { url: localUri, title, dialogTitle: t("search.share.dialogPdf") },
      }
    })
  }

  function shareTranscriptText(trackId: TrackId): Promise<void> {
    const lang = reqLang()
    return run("pdf", `text:${trackId}:${lang}`, t("search.share.preparingText"), async () => {
      const repos = app.repositories()
      const langs = await repos.transcripts.availableLanguages(trackId)
      if (langs.length === 0) return { ok: false, reason: "no_transcript" }
      const chosen = langs.includes(lang) ? lang : langs[0]
      const transcript = await repos.transcripts.get(trackId, chosen)
      const body = transcriptToText(transcript)
      if (!body) return { ok: false, reason: "no_transcript" }

      const track = await repos.tracks.getById(trackId)
      const title = resolveTrackTitle(track, lang) ?? trackId
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
    const lang = reqLang()
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

      const title = resolveTrackTitle(track, lang) ?? trackId
      return {
        ok: true,
        options: { url: localUri, title, dialogTitle: t("search.share.dialogAudio") },
      }
    })
  }

  return { presentShareMenu }
}
