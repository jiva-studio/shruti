import { type InboxTrack } from '../models'
import { InboxTracksRepository } from '../repositories/InboxTracksRepository'


export class InboxTracksService {
  constructor(
    private readonly inboxTracksRepository: InboxTracksRepository
  ) {}

  async getProcessable(): Promise<InboxTrack[]> {
    return await this.inboxTracksRepository.getMany({
      selector: {
        status: {
          $in: [
            "verification",
            "pending",
            "error",
          ]
        }
      },
      limit: 8192,
    })
  }
}
