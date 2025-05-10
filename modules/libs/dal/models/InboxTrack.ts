export type DocumentId = string;
type Reference = Array<string | number>;

export type NormalizedValue<
  TNormalizedType,
  TOriginalType = string
> = {
  extracted: TOriginalType;
  normalized?: TNormalizedType | undefined;
}

export type InboxStatus = "new" | "verification" | "pending" | "processing" | "processed" | "error";

export type InboxTrack = {
  _id: string;
  path: string;
  status: InboxStatus 
  date: NormalizedValue<number[]>;
  references: NormalizedValue<Reference[]>;
  title: NormalizedValue<string>;
  author: NormalizedValue<DocumentId>;
  location: NormalizedValue<DocumentId>;
  tags: string[] | undefined;
  languagesExtract: string[];
  languagesTranslateInto: string[];
};
