/**
 * Type representing the request for an audio segment extraction.
 */
export type AudioSegmentRequest = {
  trackId: string;
  audioType: string;
  timeStart: number;
  timeEnd: number;
};

export type AudioSegmentResponse = {
  signedUrl: string
};