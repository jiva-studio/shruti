/**
 * Type representing the request for an audio segment extraction.
 */
export type AudioSegmentRequest = {
  filePath: string;
  timeStart: number;
  timeEnd: number;
};

export type AudioSegmentResponse = {
  signedUrl: string
};