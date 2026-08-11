export default {
  downloadFailed: "Download failed. Check your internet connection and try again.",
  filtersNotSaved: "Couldn't save the filter. It will be reset on next launch.",
  downloadsCacheUnavailable: "Couldn't read your downloads index. Cached files are still on disk.",
  trackNotFound: "Track not found.",
  languageListUnavailable: "Couldn't load languages — showing a short list.",
  dictionariesUnavailable: "Couldn’t load names — some labels may be missing.",
  playbackFailed: "Couldn’t play this lecture. Check your connection and try again.",
  noAudioForLecture: "This lecture has no audio.",
  translationFailed: "Translation into {language} failed. Please try again later.",
  translationStillRunning:
    "The {language} translation is taking longer than usual — it will appear once it's ready.",
  downloadStorageFull:
    "Storage limit reached. Remove listened lectures or raise the limit in Settings.",
  downloadStorageFullAction: "Download anyway",
  // The storage-error screen (`views/StorageError`) — shown when the local
  // databases could not be opened at all.
  storage: {
    title: "Your data couldn't be opened",
    description:
      "The database that holds your notes, playlist and listening history didn't open, so the app can't show your library.",
    advice:
      "Restart the app to try again. If it keeps happening, free up storage space on your device or reinstall the app.",
    retry: "Try again",
  },
}
