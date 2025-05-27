import { PlaylistItem } from '@lectorium/dal/models'
import { PlaylistStoreItem } from './usePlaylistStore'
import { useDAL } from '@lectorium/mobile/features/app.database'
import { mapAuthorFullNameById, mapLocationFullNameById, mapReference, mapTagFullNameById, mapTrackDate, mapTrackTitle } from '@lectorium/mobile/features/app.tracks'

type Options = {
  playlistItem: PlaylistItem
  language: string
}

export function usePlaylistItemMapper() {

  async function map({
    playlistItem,
    language = 'en',
  }: Options): Promise<PlaylistStoreItem> {
    const dal = useDAL()
    const track = await dal.tracks.getOne(playlistItem.trackId)
    return {
      playlistItemId: playlistItem._id,
      trackId: track._id,
      completedAt: playlistItem.completedAt,
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