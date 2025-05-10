export type Track = {
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
  transcripts: Record<string, {
    path: string;
  }>;
  tags?: string[];
}
