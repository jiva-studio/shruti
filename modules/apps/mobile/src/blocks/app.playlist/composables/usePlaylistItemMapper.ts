import { PlaylistItem, Track } from '@lectorium/dal'
import { mapAuthorFullNameById, mapLocationFullNameById, mapReference, mapTagFullNameById, mapTrackDate, mapTrackTitle } from '@blocks/app.tracks'
import { PlaylistStoreItem } from '../models/PlaylistStoreItem'

type Options = {
  playlistItem: PlaylistItem
  track: Track,
  language: string
}

export function usePlaylistItemMapper() {

  async function map({
    playlistItem,
    track,
    language = 'en',
  }: Options): Promise<PlaylistStoreItem> {
    return {
      playlistItemId: playlistItem._id,
      trackId: track._id,
      completedAt: playlistItem.completedAt,
      progress: playlistItem.progress,
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