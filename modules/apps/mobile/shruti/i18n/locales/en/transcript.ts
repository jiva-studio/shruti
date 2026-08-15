export default {
  /** The transcript DOCUMENT failed to load with nothing left to read —
   *  this replaces the whole reader, so it must not be a raw error code
   *  in English (#1845). */
  loadError: {
    fetchFailed: "Couldn't load the transcript. Check your connection and try again.",
    languageNotAvailable: "The transcript isn't available in this language.",
    notAvailable: "No transcript is available for this lecture.",
  },
  noneAvailable: "No transcripts available for this track.",
  loading: "Loading transcript…",
  contents: "Contents",
  similarByTopic: "Similar lectures",
  similarByTopicReason: "Similar topics: {topics}",
}
