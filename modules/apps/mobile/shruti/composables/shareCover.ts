import type { LanguageCode } from "@lib/domain/core.js"
import type { Author } from "@lib/domain/author.js"
import type { Location } from "@lib/domain/location.js"
import type { Source } from "@lib/domain/source.js"
import type { Tag } from "@lib/domain/tag.js"
import type { Track } from "@lib/domain/track.js"
import type { RenderTranscriptRequest } from "@ports/app/index.js"
import { resolveLocalizedName, resolveTrackTitle } from "@lib/domain/services/localizedName.js"

export type ShareCover = Pick<
  RenderTranscriptRequest,
  "title" | "author" | "date" | "location" | "references" | "tags" | "outline"
>

export interface ShareCoverDictionaries {
  readonly authorsById: ReadonlyMap<string, Author>
  readonly locationsById: ReadonlyMap<string, Location>
  readonly sourcesById: ReadonlyMap<string, Source>
  readonly tagsById: ReadonlyMap<string, Tag>
}

const EMPTY_COVER: ShareCover = {
  title: null,
  author: null,
  date: null,
  location: null,
  references: [],
  tags: [],
  outline: null,
}

function coverReferences(
  track: Track,
  sourcesById: ShareCoverDictionaries["sourcesById"],
  lang: LanguageCode
): ShareCover["references"] {
  return track.references.map((reference) => {
    const source = reference.sourceId ? sourcesById.get(reference.sourceId) : undefined
    const name = source ? (source.names.get(lang) ?? [...source.names.values()][0]) : undefined
    const tokens = reference.tokens.join(".")
    return {
      shortName: name?.shortName ?? null,
      fullName: name?.fullName ?? null,
      sourceId: reference.sourceId,
      tokens: tokens || null,
    }
  })
}

/**
 * The share-transcript cover fields, in the same shape the chat tool sends, so
 * a Library PDF and a chat PDF of the same lecture carry an identical cover.
 * Every field is optional — the renderer degrades gracefully.
 */
export function buildShareCover(
  track: Track | null | undefined,
  dicts: ShareCoverDictionaries,
  lang: LanguageCode
): ShareCover {
  if (!track) return { ...EMPTY_COVER }
  return {
    title: resolveTrackTitle(track, lang) ?? null,
    author: track.authorId
      ? (resolveLocalizedName(dicts.authorsById.get(track.authorId), lang) ?? null)
      : null,
    date: track.date || null,
    location: track.locationId
      ? (resolveLocalizedName(dicts.locationsById.get(track.locationId), lang) ?? null)
      : null,
    references: coverReferences(track, dicts.sourcesById, lang),
    tags: track.tagIds
      .map((id) => resolveLocalizedName(dicts.tagsById.get(id), lang))
      .filter((name): name is string => Boolean(name)),
    outline: track.variants.find((v) => v.language === lang)?.outline ?? null,
  }
}
