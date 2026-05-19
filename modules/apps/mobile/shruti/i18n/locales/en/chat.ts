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
  errRate: "Too many requests. Try again in a minute.",
  errNetwork: "Couldn't reach the chat service. Check your connection.",
  errServiceNotReady: "Chat service is warming up. Try again shortly.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Couldn't put an answer together. Try a more focused query.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (cut off — connection dropped)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (stopped — too many tool calls)",

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Recap current lecture",
  suggestionRecapRecent: "Recap last lecture",
  followupAriaLabel: "Suggested follow-up: {text}",
  suggestions: [
    "Where did I stop?", // list_my_tracks(status='in_progress')
    "Playlist on Gita ch. 2", // propose_playlist
    "Lectures on BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "What I heard this week", // list_my_tracks(since=now-7d)
    "What to listen next?", // recommend_next
    "About bhakti", // search_transcripts (semantic)
    "What is the soul?", // search_transcripts (semantic)
    "Bombay morning walks", // list_tracks(location=Bombay, tag=morning_walk)
    "Vrindavan conversations", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF of last lecture", // generate_track_pdf
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

  noteSaved: "Note saved",
  noteSaving: "Saving note…",

  actionPdfKind: "Lecture transcript",
  actionPdfShare: "Share",
  actionPdfShared: "Sent",
  actionPdfError: "Couldn't prepare the PDF.",
  actionPdfDialog: "Share transcript",

  actionDismiss: "Skip",
  actionDismissed: "Dismissed",
  actionRetry: "Retry",
  actionDegraded: "Action card data is missing.",

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Daily reminder",
  proactiveSessionTitleSmartLibrary: "Smart Library",
  proactiveSessionTitleNextShloka: "Next verse",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "You were on the previous verse — keep going in order. The next one is here: {ref} “{title}”. Add it to your library?",

  proactiveSmartLibraryHintBody:
    "I'd like to show you Smart Library — a Pro feature that keeps your library full of fresh lectures without your having to queue anything by hand.\n\nYou pick the criteria — favourite authors, topics, sources, lecture length — and Smart Library quietly pulls matching lectures into your library to a target queue duration (e.g. 2 hours, 8 hours, 10 hours). When something is finished it gets archived automatically so the queue stays fresh.\n\nGood for commutes and walks where you don't want to spend time choosing what to listen to next.",
  proactiveEnableNotificationsBody:
    "You've been listening a few days in a row — nice rhythm. I'd like to suggest setting up a daily reminder so you don't lose it.\n\nIt's one gentle local notification at the time you choose (I'll start with 07:00, you can change it any time in Settings). No noise on the network — it lives on your device and only fires when the time comes.\n\nUseful as a daily anchor: a small nudge that the lecture is waiting whenever your day allows.",

  actionEnableReminderTitle: "Daily reminder",
  actionEnableReminderBody:
    "Pick a time each day and I'll nudge you to come listen. You can change or turn it off later in Settings.",
  actionEnableReminderConfirm: "Turn on",
  actionEnableReminderDone: "Daily reminder is set.",
  actionEnableReminderError: "Couldn't enable notifications.",

  actionConfigureSmartLibraryTitle: "Smart Library",
  actionConfigureSmartLibraryBody:
    "Keep fresh lectures on your topics queued offline. I can pre-fill these filters for you.",
  actionConfigureSmartLibraryConfirm: "Set up",
  actionConfigureSmartLibraryDone: "Opened in Settings.",
  actionConfigureSmartLibraryError: "Couldn't open Smart Library.",
  actionConfigureSmartLibraryChipAuthors: "{n} authors",
  actionConfigureSmartLibraryChipTopics: "{n} topics",
  actionConfigureSmartLibraryChipSources: "{n} sources",
  actionConfigureSmartLibraryChipLocations: "{n} locations",
  actionConfigureSmartLibraryChipLanguages: "{n} languages",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Unlock Smart Library, the Notes Studio, and the rest of Pro to get the most out of Shruti.",
  actionUpgradeToProConfirm: "See Pro",
  actionUpgradeToProDone: "Paywall opened.",
  actionUpgradeToProError: "Couldn't open the upgrade screen.",

  actionQueueNextTrackTitle: "Add to library",
  actionQueueNextTrackConfirm: "Add",
  actionQueueNextTrackDone: "Added to library.",
  actionQueueNextTrackError: "Couldn't add this lecture.",

  citationSaveAsNote: "Save as note",
  citationOpenInStudio: "Open in Studio",
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
