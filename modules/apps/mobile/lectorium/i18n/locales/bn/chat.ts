export default {
  title: "চ্যাট",
  placeholder: "একটি প্রশ্ন করুন",
  send: "পাঠান",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "থামান",
  sending: "ভাবছি…",
  emptyStateTitle: "আমি কীভাবে সাহায্য করতে পারি?",
  emptyState: "যা খুশি জিজ্ঞাসা করুন — আমি রেকর্ডিংয়ে খুঁজে দেখব।",
  newSession: "নতুন চ্যাট",
  history: "চ্যাটের ইতিহাস",
  historyEmpty: "এখনও কোনও চ্যাট নেই।",
  searchPlaceholder: "ইতিহাসে অনুসন্ধান",
  searchEmpty: "কিছু মেলেনি",
  untitledSession: "শিরোনামহীন চ্যাট",
  clearHistory: "চ্যাটের ইতিহাস মুছুন",
  clearHistoryConfirm: "সব চ্যাট সেশন ও বার্তা মুছে ফেলবেন? এটি আর ফেরানো যাবে না।",
  clearedToast: "চ্যাটের ইতিহাস মুছে ফেলা হয়েছে।",
  citationActionHeader: "উদ্ধৃতি খুলুন",
  citationOpen: "লেকচার খুলুন",
  citationListen: "ক্লিপ শুনুন",
  citationLoading: "লোড হচ্ছে…",
  citationOpenFull: "পূর্ণ লেকচার খুলুন",
  citationDetailsTitle: "উদ্ধৃতির বিবরণ",
  citationNoAudio: "এই উদ্ধৃতির জন্য কোনও অডিও নেই",
  citationLoadFailed: "অংশটি লোড করা যায়নি",
  citationAddedToPlaylist: "প্লেলিস্টে যোগ করা হয়েছে",
  citationAddFailed: "প্লেলিস্টে যোগ করা যায়নি",
  citationMtBadge: "স্বয়ংক্রিয়ভাবে অনূদিত",
  citationViewOriginal: "মূল দেখান",
  citationViewTranslated: "অনুবাদ দেখান",
  lectureCardMissing: "লোকাল ক্যাটালগে লেকচারটি নেই।",
  errRate: "অনেক বেশি অনুরোধ। এক মিনিট পরে আবার চেষ্টা করুন।",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "অনেক বেশি অনুরোধ। {when} আবার চেষ্টা করুন।",
  errNetwork: "চ্যাট সার্ভিসে পৌঁছানো যায়নি। আপনার সংযোগ পরীক্ষা করুন।",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "ইন্টারনেট নেই",
    body: "আপনি আবার অনলাইন হলে পুনরায় চেষ্টা করা হবে।",
    cta: "পুনরায় চেষ্টা (স্বয়ংক্রিয়)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "সার্ভারে পৌঁছানো যায়নি",
    body: "একটু পরে আবার চেষ্টা করুন।",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "চ্যাট সাময়িকভাবে অনুপলব্ধ",
    body: "এই মুহূর্তে আপনার বার্তা পাঠানো যায়নি। অনুগ্রহ করে একটু পরে আবার চেষ্টা করুন।",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "অনুরোধের সীমা",
  errQuotaUnknownBody: "দৈনিক সীমা শেষ, পরে আবার চেষ্টা করুন।",
  errServiceNotReady: "চ্যাট সার্ভিস চালু হচ্ছে। একটু পরে আবার চেষ্টা করুন।",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "চ্যাট সার্ভিস একটি ত্রুটি ফেরত দিয়েছে। একটু পরে আবার চেষ্টা করুন।",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "অনুমোদন ব্যর্থ হয়েছে। আবার চেষ্টা করতে অ্যাপটি পুনরায় চালু করুন।",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "অ্যাপের এই সংস্করণটি আর সমর্থিত নয়। অনুগ্রহ করে আপডেট করুন।",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "আপডেট প্রয়োজন",
      body: "চ্যাট একটি নতুন প্রোটোকল ব্যবহার করে। চালিয়ে যেতে Lectorium আপডেট করুন।",
      cta: "স্টোর খুলুন",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "সাময়িক বিভ্রাট",
      body: "একটু পরে আবার চেষ্টা করুন।",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "উত্তর আসার আগেই সংযোগ বিচ্ছিন্ন হয়েছে।",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "একটি উত্তর পাওয়া যায়নি।",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "উত্তর তৈরি করা যায়নি। আরও নির্দিষ্ট একটি প্রশ্ন করুন।",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (অসম্পূর্ণ — সংযোগ বিচ্ছিন্ন হয়েছে)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (থেমে গেছে — অনেক বেশি টুল কল)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (থামানো হয়েছে)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "{n} সেকেন্ডে",
  retryInMinutes: "{n} মিনিটে",
  retryAtTime: "{time}-এ",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "আগামীকাল {time}-এ",
  retryNow: "এখন",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "দৈনিক বার্তার সীমা শেষ",
  errQuotaAnonBody: "প্রতিদিন আরও বেশি চ্যাট বার্তা পেতে সাইন ইন করুন। {when} রিসেট হবে।",
  errQuotaFreeTitle: "দৈনিক বার্তার সীমা শেষ",
  errQuotaFreeBody: "Shruti Pro দৈনিক বার্তার সীমা তুলে দেয়। {when} রিসেট হবে।",
  errQuotaProTitle: "দৈনিক সীমা শেষ",
  errQuotaProBody: "আপনি আজকের চ্যাট বার্তা শেষ করে ফেলেছেন। {when} রিসেট হবে।",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "সাইন ইন করুন",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "দৈনিক সীমা শেষ — পরে আবার চেষ্টা করুন",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "লেখা বিরতিতে আছে, দৈনিক সীমা {when} রিসেট হবে",
  composeLimitedAriaLabelNoTime: "লেখা বিরতিতে আছে, দৈনিক সীমা শেষ",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% ব্যবহৃত · {date} {time}-এ রিসেট",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "বর্তমান লেকচারের সারাংশ",
  suggestionRecapRecent: "শেষ লেকচারের সারাংশ",
  followupAriaLabel: "প্রস্তাবিত পরবর্তী প্রশ্ন: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "এই অংশটির অর্থ কী?",
    "সহজ ভাষায় ব্যাখ্যা করুন",
    "আরও প্রসঙ্গ দিন",
    "এটি কোন শাস্ত্র থেকে?",
  ],
  suggestions: [
    "আমি কোথায় থেমেছিলাম?", // user_tracks_list(status='in_progress')
    "গীতার ২য় অধ্যায়ের প্লেলিস্ট", // propose_playlist
    "BG 2.11–20-এর লেকচার", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "এই সপ্তাহে যা শুনেছি", // user_tracks_list(since=now-7d)
    "এরপর কী শুনব?", // user_recommendations_get
    "ভক্তি সম্পর্কে", // chunks_search (semantic)
    "আত্মা কী?", // chunks_search (semantic)
    "বোম্বে মর্নিং ওয়াক", // list_tracks(location=Bombay, tag=morning_walk)
    "বৃন্দাবনের কথোপকথন", // list_tracks(location=Vrindavan, tag=conversation)
    "শেষ লেকচারের PDF", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "কৃষ্ণ কে?",
    "আমরা কেন কষ্ট পাই?",
    "কর্ম কী?",
    "পুনর্জন্ম কী?",
    "কেন মন্ত্র জপ করব?",
    "ভক্তি কী?",
    "গুরু কে?",
    "কেন ভগবদ্গীতা পড়ব?",
    "কেন নিরামিষ আহার?",
    "জীবনের অর্থ কী?",
    "মৃত্যুর পরে কী হয়?",
    "ধর্ম কী?",
    "শ্রীল প্রভুপাদ কে?",
    "সাধনা কোথা থেকে শুরু করব?",
    "ভগবানের প্রতি প্রেম কীভাবে গড়ে তুলব?",
    "পবিত্র নাম কী?",
    "কৃষ্ণের উপর কীভাবে ধ্যান করব?",
  ],

  outlineTitle: "রূপরেখা",
  outlineMore: "আরও {n}টি দেখান",
  outlineRecapPrompt: "{from}–{to} অংশের সারাংশ: {title}",

  trackListAddAllToPlaylist: "সব প্লেলিস্টে যোগ করুন",
  trackListAddAllDone: "{n}টি লেকচার প্লেলিস্টে যোগ করা হয়েছে",
  trackListAddAllPartial: "{added}টি যোগ হয়েছে, {failed}টি ব্যর্থ",
  trackListAddAllFailed: "লেকচারগুলো প্লেলিস্টে যোগ করা যায়নি।",
  actionOpenLibrary: "খুলুন",
  actionOpenNotes: "খুলুন",
  miniRowOpen: "লেকচার খুলুন",

  noteSaved: "নোট সংরক্ষিত হয়েছে",
  noteSaving: "নোট সংরক্ষণ করা হচ্ছে…",

  actionPdfKind: "লেকচারের ট্রান্সক্রিপ্ট",
  actionPdfShare: "শেয়ার করুন",
  actionPdfShared: "পাঠানো হয়েছে",
  actionPdfError: "PDF প্রস্তুত করা যায়নি।",
  actionPdfDialog: "ট্রান্সক্রিপ্ট শেয়ার করুন",

  actionDismiss: "এড়িয়ে যান",
  actionDismissed: "বাতিল করা হয়েছে",
  actionRetry: "পুনরায় চেষ্টা",
  actionDegraded: "অ্যাকশন কার্ডের তথ্য নেই।",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "বার্তা কপি করুন",
  copyDone: "কপি করা হয়েছে",
  /** Aria-label for the inline message Share button. */
  shareAction: "বার্তা শেয়ার করুন",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "ভালো উত্তর",
    thumbsDown: "খারাপ উত্তর",
    thanks: "মতামতের জন্য ধন্যবাদ",
    failed: "মতামত পাঠানো যায়নি — আবার চেষ্টা করুন",
    sheet: {
      title: "কী ভুল ছিল?",
      hint: "সব ক্ষেত্র ঐচ্ছিক। পাঠাতে সাবমিট চাপুন।",
      categoryLabel: "ধরন",
      categoryPlaceholder: "একটি বেছে নিন (ঐচ্ছিক)",
      commentLabel: "মন্তব্য",
      commentPlaceholder: "আর কিছু? (ঐচ্ছিক)",
      submit: "সাবমিট",
    },
    categories: {
      off_topic: "বিষয়বহির্ভূত",
      no_results: "কিছু পাওয়া যায়নি",
      bad_citations: "খারাপ উদ্ধৃতি",
      wrong_language: "ভুল ভাষা",
      factually_wrong: "তথ্যগতভাবে ভুল",
      other: "অন্যান্য",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "দৈনিক অনুস্মারক",
  proactiveSessionTitleSmartLibrary: "স্মার্ট লাইব্রেরি",
  proactiveSessionTitleNextShloka: "পরবর্তী শ্লোক",
  proactiveSessionTitleUnfinishedLecture: "অসম্পূর্ণ লেকচার",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "আপনি আগের শ্লোকটিতে ছিলেন — ক্রম অনুসারে এগিয়ে যান। পরবর্তীটি এখানে আছে: {ref} “{title}”। এটি আপনার লাইব্রেরিতে যোগ করবেন?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "আপনি “{title}” শুরু করেছিলেন কিন্তু শেষ করেননি। যেখানে থেমেছিলেন সেখান থেকে চালিয়ে যেতে চান?",

  proactiveSmartLibraryHintBody:
    "আমি আপনাকে স্মার্ট লাইব্রেরি দেখাতে চাই — এটি একটি Pro সুবিধা যা হাতে কোনও কিছু যোগ না করেই আপনার লাইব্রেরিকে নতুন লেকচারে ভরে রাখে।\n\nআপনি মাপকাঠি বেছে নেন — প্রিয় বক্তা, বিষয়, উৎস, লেকচারের দৈর্ঘ্য — আর স্মার্ট লাইব্রেরি নিঃশব্দে মিলে যাওয়া লেকচারগুলো একটি লক্ষ্য সারির দৈর্ঘ্য পর্যন্ত (যেমন ২ ঘণ্টা, ৮ ঘণ্টা, ১০ ঘণ্টা) আপনার লাইব্রেরিতে টেনে নেয়। কোনও কিছু শেষ হলে তা স্বয়ংক্রিয়ভাবে সংরক্ষণাগারে চলে যায়, তাই সারিটি সতেজ থাকে।\n\nযাতায়াত ও হাঁটার সময় ভালো, যখন পরবর্তীতে কী শুনবেন তা বেছে নিতে সময় ব্যয় করতে চান না।",
  proactiveEnableNotificationsBody:
    "আপনি কয়েক দিন ধরে টানা শুনছেন — চমৎকার ছন্দ। এটি যেন না হারায় সেজন্য একটি দৈনিক অনুস্মারক সেট করার পরামর্শ দিচ্ছি।\n\nএটি আপনার বেছে নেওয়া সময়ে একটি মৃদু লোকাল নোটিফিকেশন (আমি ০৭:০০ দিয়ে শুরু করব, সেটিংসে যেকোনো সময় বদলাতে পারবেন)। নেটওয়ার্কে কোনও হইচই নেই — এটি আপনার ডিভাইসেই থাকে এবং কেবল সময় হলেই বাজে।\n\nদৈনিক ভিত্তি হিসেবে কাজে আসে: একটি ছোট্ট ইঙ্গিত যে লেকচার অপেক্ষা করছে, যখনই আপনার দিন অনুমতি দেয়।",

  actionEnableReminderTitle: "দৈনিক অনুস্মারক",
  actionEnableReminderBody:
    "প্রতিদিনের একটি সময় বেছে নিন, আমি আপনাকে শুনতে আসার কথা মনে করিয়ে দেব। পরে সেটিংসে বদলাতে বা বন্ধ করতে পারবেন।",
  actionEnableReminderConfirm: "চালু করুন",
  actionEnableReminderDone: "দৈনিক অনুস্মারক সেট করা হয়েছে।",
  actionEnableReminderError: "নোটিফিকেশন চালু করা যায়নি।",

  actionConfigureSmartLibraryTitle: "স্মার্ট লাইব্রেরি",
  actionConfigureSmartLibraryBody:
    "আপনার বিষয়গুলোর নতুন লেকচার অফলাইনে সারিবদ্ধ রাখুন। আমি আপনার জন্য এই ফিল্টারগুলো আগে থেকেই পূরণ করে দিতে পারি।",
  actionConfigureSmartLibraryConfirm: "সেট আপ করুন",
  actionConfigureSmartLibraryDone: "সেটিংসে খোলা হয়েছে।",
  actionConfigureSmartLibraryError: "স্মার্ট লাইব্রেরি খোলা যায়নি।",
  actionConfigureSmartLibraryChipAuthors: "{n} জন বক্তা",
  actionConfigureSmartLibraryChipTopics: "{n}টি বিষয়",
  actionConfigureSmartLibraryChipSources: "{n}টি উৎস",
  actionConfigureSmartLibraryChipLocations: "{n}টি স্থান",
  actionConfigureSmartLibraryChipLanguages: "{n}টি ভাষা",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "অ্যাপটি থেকে সবচেয়ে বেশি সুবিধা পেতে স্মার্ট লাইব্রেরি, নোটস স্টুডিও এবং Pro-র বাকি সবকিছু আনলক করুন।",
  actionUpgradeToProConfirm: "Pro দেখুন",
  actionUpgradeToProDone: "পেওয়াল খোলা হয়েছে।",
  actionUpgradeToProError: "আপগ্রেড স্ক্রিন খোলা যায়নি।",

  actionQueueNextTrackTitle: "লাইব্রেরিতে যোগ করুন",
  actionQueueNextTrackConfirm: "যোগ করুন",
  actionQueueNextTrackDone: "লাইব্রেরিতে যোগ করা হয়েছে।",
  actionQueueNextTrackError: "এই লেকচারটি যোগ করা যায়নি।",

  citationSaveAsNote: "নোট হিসেবে সংরক্ষণ করুন",
  citationOpenInStudio: "স্টুডিওতে খুলুন",
  citationAddLectureToPlaylist: "লেকচারটি প্লেলিস্টে যোগ করুন",
  recentSessionsLabel: "সাম্প্রতিক চ্যাট",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "এইমাত্র",
  timeYesterday: "গতকাল",
  timeUnitMinute: "মি",
  timeUnitHour: "ঘ",
  timeUnitDay: "দি",
  timeUnitWeek: "সপ্তা",
  timeUnitMonth: "মাস",
  timeUnitYear: "বছর",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "ভাবছি…",
    searching_corpus: "রেকর্ডিংয়ে খুঁজছি…",
    composing_answer: "উত্তর লিখছি…",
    preparing_action: "প্রস্তুত করছি…",
    browsing_catalog: "ক্যাটালগ দেখছি…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "প্রশ্ন বাছাই করছি…",
  },
}
