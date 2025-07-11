import type { Track } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

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
  hidden: boolean;
}

const trackSerializer = (item: Track): TracksDBSchema => item
const trackDeserializer = (document: TracksDBSchema): Track => document

/**
 * Repository for managing Tracks
 */
export class TracksRepository extends PouchRepository<Track, TracksDBSchema> {
  constructor(database: Database) {
    super(
      database, 
      trackSerializer, 
      trackDeserializer, 
      { type: "track" },
    )
  }
}
