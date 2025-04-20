export type TranscriptBlock = {
  type: "sentence" | "paragraph";
  start: number;
  end: number;
  text: string;
}

export type Transcript = {
  version: number;
  blocks: TranscriptBlock[];
}
