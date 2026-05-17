export default {
  title: "Chat",
  placeholder: "Just ask a question…",
  send: "Send",
  sending: "Thinking…",
  emptyStateTitle: "How can I help?",
  emptyState: "Ask anything — I'll look it up in the recordings.",
  newSession: "New chat",
  history: "Chat history",
  historyEmpty: "No previous chats yet.",
  searchPlaceholder: "Search history",
  searchEmpty: "No matches",
  untitledSession: "Untitled chat",
  clearHistory: "Clear chat history",
  clearHistoryConfirm: "Delete every chat session and message? This cannot be undone.",
  clearedToast: "Chat history cleared.",
  citationActionHeader: "Open citation",
  citationOpen: "Open lecture",
  citationListen: "Listen to clip",
  citationLoading: "Loading…",
  citationOpenFull: "Open full lecture",
  citationDetailsTitle: "Citation details",
  citationNoAudio: "No audio available for this citation",
  citationLoadFailed: "Couldn't load the snippet",
  citationAddedToPlaylist: "Added to playlist",
  citationAddFailed: "Couldn't add to playlist",
  lectureCardMissing: "Lecture not available in the local catalog.",
  showTab: "Chat tab",
  showTabHint: "Adds a Chat tab to the bottom navigation.",
  errRate: "Too many requests. Try again in a minute.",
  errNetwork: "Couldn't reach the chat service. Check your connection.",
  errServiceNotReady: "Chat service is warming up. Try again shortly.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (cut off — connection dropped)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (stopped — too many tool calls)",
  /** Last-resort name for a salvaged playlist when the user's prompt
   *  isn't usable as a title (empty, whitespace-only). */
  fallbackPlaylistName: "Playlist",

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Recap current lecture",
  suggestionRecapRecent: "Recap last lecture",
  suggestions: [
    "Where did I stop?",          // continue_listening
    "Playlist on Gita ch. 2",     // propose_playlist
    "What I heard this week",     // search_my_history + now
    "Search my notes",            // search_my_notes
    "What to listen next?",       // recommend_next
    "About varnashrama",          // search_transcripts (classic)
    "Bombay morning walks 1973",  // list_tracks (classic)
  ],

  outlineTitle: "Outline",
  outlineMore: "Show {n} more",
  outlineRecapPrompt: "Recap segment {from}–{to}: {title}",

  actionPlaylistKind: "Suggested playlist",
  actionPlaylistBadge: "{n} lectures",
  actionPlaylistMore: "and {n} more — expand",
  actionPlaylistConfirm: "Create",
  actionPlaylistDone: "Lectures added to playlist",
  actionPlaylistError: "Couldn't create the playlist.",
  actionOpenLibrary: "Open",
  actionOpenNotes: "Open",
  miniRowOpen: "Open lecture",

  actionNoteKind: "Save as note",
  actionNoteConfirm: "Save",
  actionNoteDone: "Note saved",
  actionNoteError: "Couldn't save the note.",
  noteSaved: "Note saved",
  noteSaving: "Saving note…",

  actionDismiss: "Skip",
  actionDismissed: "Dismissed",
  actionRetry: "Retry",
  actionDegraded: "Action card data is missing.",

  citationSaveAsNote: "Save as note",
  citationAddLectureToPlaylist: "Add lecture to playlist",
  recentSessionsLabel: "Recent chats",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "just now",
  timeYesterday: "yesterday",
  timeUnitMinute: "m",
  timeUnitHour: "h",
  timeUnitDay: "d",
  timeUnitWeek: "w",
  timeUnitMonth: "mo",
  timeUnitYear: "y",
}
