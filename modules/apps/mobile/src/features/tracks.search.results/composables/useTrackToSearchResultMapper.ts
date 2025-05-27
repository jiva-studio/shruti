import { Track } from '@lectorium/dal/models'
import { TrackSearchResultItem } from '@lectorium/mobile/features/tracks.search.results'
import { mapAuthorFullNameById, mapLocationFullNameById, mapReference, mapTagFullNameById, mapTrackDate, mapTrackTitle } from '@lectorium/mobile/features/app.tracks'

type Options = {
  track: Track
  language: string
}

export function useTrackToSearchResultMapper() {

  async function map({
    track, language = 'en',
  }: Options): Promise<
    TrackSearchResultItem
  > {
    // Map track to search result list item
    return {
      trackId: track._id,
      title: mapTrackTitle(track.title, language),
      author: await mapAuthorFullNameById(track.author, language), 
      location: await mapLocationFullNameById(track.location, language),
      tags: (track.tags || []).length >= 1
        ? await Promise.all((track.tags || []).map(tag => mapTagFullNameById(tag, language)))
        : [],
      references: track.references?.length >= 1 
        ? await Promise.all(track.references.map(ref => mapReference(ref, language)))
        : [],
      date: mapTrackDate(track.date),
    }
  }

  return { map }
}