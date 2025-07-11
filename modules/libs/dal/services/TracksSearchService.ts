import type { Track } from '../models'
import { type IRepository } from '../repositories/IRepository'

export type FindTracksRequest = {
  ids?: string[]
  authors?: string[]
  sources?: string[]
  locations?: string[]
  languages?: string[]
  duration?: { min: number; max: number }
  dates?: { from: string; to: string }
  sort?: 'reference' | 'date'
  limit: number
  skip: number
}

/**
 * Service for managing Tracks
 */
export class TracksSearchService {
  constructor (
    private readonly tracksRepository: IRepository<Track>
  ) {}

  async find(request: FindTracksRequest): Promise<Track[]> {
    const selector: any = {
      $or: [
        { hidden: { $exists: false } },
        { hidden: false }
      ]
    }

    if (request.ids) {
      selector._id = { $in: request.ids }
    }

    if (request.authors) { 
      selector.author = { $in: request.authors } 
    }

    if (request.sources) {
      selector.references = { 
        $elemMatch: { 0: { $in: request.sources } }
      } 
    }

    if (request.locations) { 
      selector.location = { $in: request.locations } 
    }
       
    if (request.languages) {
      selector.languages = {
        $elemMatch: {
          language: { $in: request.languages },
          source:   { $eq: 'track' }
        }
      }
    }

    if (request.dates && (request.dates.from || request.dates.to)) {
      // convert iso date to array of [year, month, day]
      const date = (iso: string) => {
        const d = new Date(iso)
        return [d.getFullYear(), d.getMonth()+1, d.getDate()]
      }
      selector.date = {}
      if (request.dates.from) { selector.date.$gte = date(request.dates.from) }
      if (request.dates.to)   { selector.date.$lte = date(request.dates.to) }
    }

    if (request.duration) {
      selector.audio = {
        "original.duration": {
          "$gt": request.duration.min,
          "$lte": request.duration.max
        }
      }
    }

    if (request.sort) {
      selector['sort_' + request.sort] = { $exists: true }
    }

    return await this.tracksRepository.getMany({ 
      selector, 
      limit: request.limit, 
      skip: request.skip,
      sort: request.sort ? ['sort_' + request.sort] : undefined
    })
  }
}
