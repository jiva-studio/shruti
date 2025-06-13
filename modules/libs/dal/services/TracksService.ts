import type { Track } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

/**
 * Schema of the Track documents in the Library collection.
 */
type TracksDBSchema = {
  _id: string;
  type: "track";
  version: number;
  location: string;
  date: [number, number, number];
  author: string;
  title: Record<string, string>;
  references: Array<string|number>[];
  audio: {
    original: {
      path: string;
      fileSize: number;
      duration: number;
    };
  };
  languages: {
    language: string;
    source: "track" | "transcript";
    type: "original" | "generated" | "edited";
  }[];
  transcripts: Record<string, { path: string }>;
  tags?: string[];
}

const trackSerializer = (item: Track): TracksDBSchema => item
const trackDeserializer = (document: TracksDBSchema): Track => document

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
export class TracksService extends DatabaseService<Track, TracksDBSchema> {
  constructor(database: Database) {
    super(
      database, 
      trackSerializer, 
      trackDeserializer, 
      { type: "track" },
    )
  }

  async find(request: FindTracksRequest): Promise<Track[]> {
    const selector: any = {}

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

    return await this.getMany({ 
      selector, 
      limit: request.limit, 
      skip: request.skip,
      sort: request.sort ? ['sort_' + request.sort] : undefined
    })
  }
}
