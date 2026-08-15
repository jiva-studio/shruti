export default {
  title: "Studio",
  hint: "Tweak the quote before rendering the video.",
  placeholder: "Quote text",
  titleLabel: "Title",
  titlePlaceholder: "Optional title",
  download: "Download",
  preparing: "Preparing…",
  rendering: "Rendering reel…",
  almostReady: "Almost ready…",
  stillWorking: "Hang on, still working…",
  downloading: "Downloading…",
  shareDialog: "Share video reel",
  errorEmpty: "The quote can't be empty",
  errorNoAudio: "Audio is not available for this track",
  errorGeneric: "Couldn't prepare video. Try again.",
  /** The per-user daily render quota is spent. The bucket is a UTC day and
   *  the 429 carries no reset instant, so "tomorrow" is the only honest
   *  promise — "Try again" was advice that could not work (#1847). */
  errorRateLimited: "Daily video limit reached ({current}/{limit}). It resets tomorrow.",
  // Share-menu entry; reused by NotesView.
  openInStudio: "Open in Studio",
}
