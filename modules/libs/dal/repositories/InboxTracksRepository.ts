import { type DocumentId, type InboxTrack, type NormalizedValue, type Reference } from '../models'
import { Database } from '../persistence'
import { PouchRepository } from './PouchRepository'

export type InboxTrackDbScheme = {
  _id: string;
  path: string;
  status: "new" | "verification" | "pending" | "processing" | "processed" | "error";
  date: NormalizedValue<number[]>;
  references: NormalizedValue<Reference[]>;
  title: NormalizedValue<string>;
  author: NormalizedValue<DocumentId>;
  location: NormalizedValue<DocumentId>;
  tags: string[] | undefined;
  languagesExtract: string[];
  languagesTranslateInto: string[];
};

const inboxTrackSerializer = (item: InboxTrack): InboxTrackDbScheme => item
const inboxTrackDeserializer = (document: InboxTrackDbScheme): InboxTrack => document


export class InboxTracksRepository
  extends PouchRepository<
    InboxTrack,
    InboxTrackDbScheme
  > {
  constructor(database: Database) {
    super(
      database,
      inboxTrackSerializer,
      inboxTrackDeserializer
    )
  }
}
