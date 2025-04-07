import { type DocumentId, type InboxTrack, type NormalizedValue, type Reference } from '../models'
import { Database } from '../persistence'
import { DatabaseService } from './DatabaseService'

export type InboxTrackDbScheme = {
  _id: string;
  path: string;
  status: "new" | "verification" | "pending" | "processing" | "processed" | "error";
  date: NormalizedValue<number[]>;
  references: NormalizedValue<Reference[]>;
  title: NormalizedValue<string>;
  author: NormalizedValue<DocumentId>;
  location: NormalizedValue<DocumentId>;
  languagesExtract: string[];
  languagesTranslateInto: string[];
};

const inboxTrackSerializer = (item: InboxTrack): InboxTrackDbScheme => item
const inboxTrackDeserializer = (document: InboxTrackDbScheme): InboxTrack => document


export class InboxTracksService
  extends DatabaseService<
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

  async getProcessable(): Promise<InboxTrack[]> {
    return await this.getMany({
      selector: {
        status: {
          $in: [
            "new",
            "verification",
            "processing",
            "error",
          ]
        }
      },
      limit: 8192,
    })
  }
}
