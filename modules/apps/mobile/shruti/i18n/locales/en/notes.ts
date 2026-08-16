export default {
  /** Failures of the transcript-selection actions. Each used to reach the
   *  user as English prose with the internal `Result` code in it (#1845). */
  saveError: {
    emptyText: "Select some text first — there's nothing to save.",
    textTooLong: "That selection is too long to save as a note.",
    invalidRange: "Couldn't save the note — the selected range is invalid.",
    writeFailed: "Couldn't save the note. Try again.",
  },
  deleteError: {
    notFound: "That note is already gone.",
  },
  openError: "Couldn't open the note. Try again.",
  noteAction: "Note",
  notesAreEmpty: "No notes",
  addMoreNotes: "Add notes from lectures and they will appear here",
  notFoundTitle: "Nothing found",
  notFoundMessage: "No notes match your search. Try other words.",
  searchTruncated: "Showing the first {count} matches. Narrow your search to see the rest.",
  loadFailedTitle: "Couldn't load notes",
  loadFailedMessage: "Something went wrong while reading your notes. Try again later.",
  copyText: "Copy text",
  share: "Share",
  shareText: "Share text",
  shareAudio: "Share audio",
  shareAudioDialog: "Share audio excerpt",
  shareAudioPreparing: "Preparing audio…",
  shareAudioErrorNoAudio: "Audio is not available for this track",
  shareAudioErrorGeneric: "Couldn't prepare audio. Try again.",
  shareVideo: "Share video",
  shareInBackground: "Sharing continues in background…",
  shareAlreadyInProgress: "Another share is already in progress",
}
