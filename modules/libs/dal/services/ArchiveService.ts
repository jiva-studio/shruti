import { PlaylistItemsRepository } from '../repositories/PlaylistItemsRepository'


export class ArchiveService {
  constructor(
    private readonly playlistItemsRepository: PlaylistItemsRepository
  ) { }

  /**
   * Archives a playlist item by setting its archivedAt 
   * property to the current timestamp.
   * @param id The ID of the playlist item to archive. 
   */
  async archiveOne(id: string): Promise<void> {
    await this.playlistItemsRepository.patchOne(id, { archivedAt: Date.now() })
  }
}
