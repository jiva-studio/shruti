export default {
  title: "Chat",
  placeholder: "Ask a question",
  send: "Send",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Stop",
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
  citationMtBadge: "Translated automatically",
  citationViewOriginal: "Show original",
  citationViewTranslated: "Show translation",
  lectureCardMissing: "Lecture not available in the local catalog.",
  errRate: "Too many requests. Try again in a minute.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Too many requests. Try again {when}.",
  errNetwork: "Couldn't reach the chat service. Check your connection.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "No internet",
    body: "Will retry when you're back online.",
    cta: "Retry (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Couldn't reach server",
    body: "Try again in a moment.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Chat is temporarily unavailable",
    body: "We couldn't send your message right now. Please try again a little later.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Rate limit",
  errQuotaUnknownBody: "Daily limit reached, try later.",
  errServiceNotReady: "Chat service is warming up. Try again shortly.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Chat service returned an error. Try again shortly.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Authorization failed. Restart the app to retry.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "This app version is no longer supported. Please update.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Update required",
      body: "Chat uses a new protocol. Update Shruti to continue.",
      cta: "Open store",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Temporary outage",
      body: "Try again in a moment.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "Connection dropped before the answer arrived.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Couldn't get a response.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Couldn't put an answer together. Try a more focused query.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (cut off — connection dropped)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (stopped — too many tool calls)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (stopped)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "in {n}s",
  retryInMinutes: "in {n} min",
  retryAtTime: "at {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "tomorrow at {time}",
  retryNow: "now",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Daily message limit reached",
  errQuotaAnonBody: "Sign in to get more chat messages per day. Resets {when}.",
  errQuotaFreeTitle: "Daily message limit reached",
  errQuotaFreeBody: "Shruti Pro lifts the daily message limit. Resets {when}.",
  errQuotaProTitle: "Daily limit reached",
  errQuotaProBody: "You've used up today's chat messages. Resets {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Sign in",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Daily limit reached — try again later",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Composing paused, daily limit resets {when}",
  composeLimitedAriaLabelNoTime: "Composing paused, daily limit reached",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% used · resets {date} at {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Recap current lecture",
  suggestionRecapRecent: "Recap last lecture",
  followupAriaLabel: "Suggested follow-up: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "What does this fragment mean?",
    "Explain in simple terms",
    "Give me more context",
    "Which scripture is this from?",
  ],
  suggestions: [
    "Where did I stop?", // user_tracks_list(status='in_progress')
    "Playlist on Gita ch. 2", // propose_playlist
    "Lectures on BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "What I heard this week", // user_tracks_list(since=now-7d)
    "What to listen next?", // user_recommendations_get
    "About bhakti", // chunks_search (semantic)
    "What is the soul?", // chunks_search (semantic)
    "Bombay morning walks", // list_tracks(location=Bombay, tag=morning_walk)
    "Vrindavan conversations", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF of last lecture", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Who is Krishna?",
    "Why do we suffer?",
    "What is karma?",
    "What is reincarnation?",
    "Why chant the mantra?",
    "What is bhakti?",
    "Who is a guru?",
    "Why read the Bhagavad-gītā?",
    "Why vegetarianism?",
    "What is the meaning of life?",
    "What happens after death?",
    "What is dharma?",
    "Who is Śrīla Prabhupāda?",
    "Where do I start the practice?",
    "How to develop love for God?",
    "What is the holy name?",
    "How to meditate on Krishna?",
  ],

  outlineTitle: "Outline",
  outlineMore: "Show {n} more",
  outlineRecapPrompt: "Recap segment {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Add all to playlist",
  trackListAddAllDone: "{n} lectures added to playlist",
  trackListAddAllPartial: "{added} added, {failed} failed",
  trackListAddAllFailed: "Couldn't add the lectures to the playlist.",
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

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Copy message",
  copyDone: "Copied",
  /** Aria-label for the inline message Share button. */
  shareAction: "Share message",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Good answer",
    thumbsDown: "Bad answer",
    thanks: "Thanks for the feedback",
    failed: "Couldn't send feedback — try again",
    sheet: {
      title: "What was wrong?",
      hint: "All fields are optional. Tap Submit to send.",
      categoryLabel: "Type",
      categoryPlaceholder: "Pick one (optional)",
      commentLabel: "Comment",
      commentPlaceholder: "Anything else? (optional)",
      submit: "Submit",
    },
    categories: {
      off_topic: "Off-topic",
      no_results: "Nothing found",
      bad_citations: "Bad citations",
      wrong_language: "Wrong language",
      factually_wrong: "Factually wrong",
      other: "Other",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Daily reminder",
  proactiveSessionTitleSmartLibrary: "Smart Library",
  proactiveSessionTitleNextShloka: "Lecture on the next verse",
  proactiveSessionTitleUnfinishedLecture: "Unfinished lecture",
  proactiveSessionTitleInactivity: "Return to your practice",

  // Static body for the `inactivity` re-engagement session. The escalating
  // copy lives on the notifications; the chat session itself carries one
  // warm welcome that's ready the moment the row is created (no LLM).
  proactiveInactivityWelcomeBody:
    "It's been a while. Fresh lectures are waiting — open your library and pick up where you left off.",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "You were on the previous verse — keep going in order. The next one is here: {ref} “{title}”. Add it to your library?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "You started “{title}” but didn’t finish it. Want to pick up where you left off?",

  proactiveSmartLibraryHintBody:
    "I'd like to show you Smart Library — a Pro feature that keeps your library full of fresh lectures without your having to queue anything by hand.\n\nYou pick the criteria — favourite authors, topics, sources, lecture length — and Smart Library quietly pulls matching lectures into your library to a target queue duration (e.g. 2 hours, 8 hours, 10 hours). When something is finished it gets archived automatically so the queue stays fresh.\n\nGood for commutes and walks where you don't want to spend time choosing what to listen to next.",
  proactiveEnableNotificationsBody:
    "You've been listening a few days in a row — nice rhythm. I'd like to suggest setting up a daily reminder so you don't lose it.\n\nIt's one gentle local notification at the time you choose (I'll start with 07:00, you can change it any time in Settings). No noise on the network — it lives on your device and only fires when the time comes.\n\nUseful as a daily anchor: a small nudge that the lecture is waiting whenever your day allows.",

  // Weekly sadhana digest card (`weekly_digest` rule). Deterministic — no
  // LLM. All labels static; lecture titles come localised from the catalog.
  weeklyDigestTitle: "Your week",
  weeklyDigestTotalTime: "Total listening time",
  weeklyDigestLectures: "Lectures this week",
  weeklyDigestStreak: "Day streak",
  weeklyDigestCompleted: "Completed",
  weeklyDigestEmpty:
    "You didn't listen this week — pick something fresh to get back into the rhythm.",
  weeklyDigestMore: "+{count} more",

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
    "Unlock Smart Library, the Notes Studio, and the rest of Pro to get the most out of the app.",
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

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Thinking…",
    searching_corpus: "Searching the recordings…",
    composing_answer: "Writing the answer…",
    preparing_action: "Preparing…",
    browsing_catalog: "Browsing the catalog…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Picking questions…",
  },
}
