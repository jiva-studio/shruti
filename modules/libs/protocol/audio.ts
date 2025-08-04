/**
 * Type representing the request for an audio segment extraction.
 */
export type AudioSegmentRequest = {
  trackId: string;
  audioType: string;
  timeStart: number;
  timeEnd: number;
};

/**
 * Type representing the response for an audio segment extraction.
 * The response is an MP3 stream, so this is mainly used for documentation.
 */
export type AudioSegmentResponse = {
  contentType: string;
  contentLength?: number;
};