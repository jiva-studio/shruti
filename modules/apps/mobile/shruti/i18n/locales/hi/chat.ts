export default {
  title: "चैट",
  placeholder: "कोई प्रश्न पूछें",
  send: "भेजें",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "रोकें",
  sending: "सोच रहा हूँ…",
  emptyStateTitle: "मैं कैसे मदद करूँ?",
  emptyState: "कुछ भी पूछें — मैं रिकॉर्डिंग्स में खोज लूँगा।",
  newSession: "नई चैट",
  history: "चैट इतिहास",
  historyEmpty: "अभी तक कोई चैट नहीं।",
  searchPlaceholder: "इतिहास में खोजें",
  searchEmpty: "कुछ नहीं मिला",
  untitledSession: "बिना शीर्षक चैट",
  clearHistory: "चैट इतिहास साफ़ करें",
  clearHistoryConfirm: "सभी चैट और संदेश हटा दें? इसे पूर्ववत नहीं किया जा सकता।",
  clearedToast: "चैट इतिहास साफ़ कर दिया गया।",
  citationActionHeader: "उद्धरण खोलें",
  citationOpen: "प्रवचन खोलें",
  citationListen: "अंश सुनें",
  citationLoading: "लोड हो रहा है…",
  citationOpenFull: "पूरा प्रवचन खोलें",
  citationDetailsTitle: "उद्धरण विवरण",
  citationNoAudio: "इस उद्धरण के लिए कोई ऑडियो उपलब्ध नहीं",
  citationLoadFailed: "अंश लोड नहीं हो सका",
  citationAddedToPlaylist: "प्लेलिस्ट में जोड़ा गया",
  citationAddFailed: "प्लेलिस्ट में नहीं जोड़ा जा सका",
  citationMtBadge: "स्वतः अनुवादित",
  citationViewOriginal: "मूल दिखाएँ",
  citationViewTranslated: "अनुवाद दिखाएँ",
  lectureCardMissing: "यह प्रवचन स्थानीय कैटलॉग में उपलब्ध नहीं है।",
  errRate: "बहुत अधिक अनुरोध। एक मिनट बाद फिर कोशिश करें।",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "बहुत अधिक अनुरोध। {when} फिर कोशिश करें।",
  errNetwork: "चैट सेवा से संपर्क नहीं हो सका। अपना कनेक्शन जाँचें।",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "इंटरनेट नहीं है",
    body: "ऑनलाइन होते ही फिर कोशिश करूँगा।",
    cta: "फिर कोशिश (स्वतः)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "सर्वर से संपर्क नहीं हो सका",
    body: "थोड़ी देर बाद फिर कोशिश करें।",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "चैट अभी अस्थायी रूप से उपलब्ध नहीं है",
    body: "हम अभी आपका संदेश नहीं भेज सके। कृपया थोड़ी देर बाद फिर कोशिश करें।",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "अनुरोध सीमा",
  errQuotaUnknownBody: "दैनिक सीमा पूरी हो गई, बाद में कोशिश करें।",
  errServiceNotReady: "चैट सेवा शुरू हो रही है। थोड़ी देर बाद फिर कोशिश करें।",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "चैट सेवा ने त्रुटि लौटाई। थोड़ी देर बाद फिर कोशिश करें।",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "प्राधिकरण विफल। फिर कोशिश करने के लिए ऐप पुनः शुरू करें।",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "ऐप का यह संस्करण अब समर्थित नहीं है। कृपया अपडेट करें।",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "अपडेट आवश्यक",
      body: "चैट एक नए प्रोटोकॉल का उपयोग करती है। जारी रखने के लिए Shruti अपडेट करें।",
      cta: "स्टोर खोलें",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "अस्थायी रुकावट",
      body: "थोड़ी देर बाद फिर कोशिश करें।",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "उत्तर आने से पहले कनेक्शन टूट गया।",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "उत्तर नहीं मिल सका।",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "उत्तर तैयार नहीं हो सका। कोई अधिक सटीक प्रश्न आज़माएँ।",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (बीच में रुक गया — कनेक्शन टूट गया)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (रुक गया — बहुत अधिक टूल कॉल)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (रोका गया)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "{n} सेकंड में",
  retryInMinutes: "{n} मिनट में",
  retryAtTime: "{time} बजे",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "कल {time} बजे",
  retryNow: "अभी",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "दैनिक संदेश सीमा पूरी हो गई",
  errQuotaAnonBody: "प्रति दिन अधिक चैट संदेश पाने के लिए साइन इन करें। {when} रीसेट होगा।",
  errQuotaFreeTitle: "दैनिक संदेश सीमा पूरी हो गई",
  errQuotaFreeBody: "Shruti Pro दैनिक संदेश सीमा हटा देता है। {when} रीसेट होगा।",
  errQuotaProTitle: "दैनिक सीमा पूरी हो गई",
  errQuotaProBody: "आपने आज के चैट संदेश पूरे कर लिए हैं। {when} रीसेट होगा।",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "साइन इन करें",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "दैनिक सीमा पूरी हो गई — बाद में फिर कोशिश करें",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "लिखना रोका गया, दैनिक सीमा {when} रीसेट होगी",
  composeLimitedAriaLabelNoTime: "लिखना रोका गया, दैनिक सीमा पूरी हो गई",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% उपयोग · {date} को {time} बजे रीसेट",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "वर्तमान प्रवचन का सार",
  suggestionRecapRecent: "पिछले प्रवचन का सार",
  followupAriaLabel: "सुझाया गया अगला प्रश्न: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "इस अंश का क्या अर्थ है?",
    "सरल शब्दों में समझाएँ",
    "और संदर्भ दें",
    "यह किस शास्त्र से है?",
  ],
  suggestions: [
    "मैं कहाँ रुका था?", // user_tracks_list(status='in_progress')
    "गीता अध्याय 2 पर प्लेलिस्ट", // propose_playlist
    "BG 2.11–20 पर प्रवचन", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "इस सप्ताह मैंने क्या सुना", // user_tracks_list(since=now-7d)
    "आगे क्या सुनूँ?", // user_recommendations_get
    "भक्ति के बारे में", // chunks_search (semantic)
    "आत्मा क्या है?", // chunks_search (semantic)
    "बॉम्बे की प्रातःकालीन सैर", // list_tracks(location=Bombay, tag=morning_walk)
    "वृंदावन की वार्ताएँ", // list_tracks(location=Vrindavan, tag=conversation)
    "पिछले प्रवचन का PDF", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "कृष्ण कौन हैं?",
    "हम दुख क्यों भोगते हैं?",
    "कर्म क्या है?",
    "पुनर्जन्म क्या है?",
    "मंत्र क्यों जपें?",
    "भक्ति क्या है?",
    "गुरु कौन हैं?",
    "भगवद्गीता क्यों पढ़ें?",
    "शाकाहार क्यों?",
    "जीवन का अर्थ क्या है?",
    "मृत्यु के बाद क्या होता है?",
    "धर्म क्या है?",
    "श्रील प्रभुपाद कौन हैं?",
    "साधना कहाँ से शुरू करूँ?",
    "भगवान के प्रति प्रेम कैसे विकसित करें?",
    "पवित्र नाम क्या है?",
    "कृष्ण पर ध्यान कैसे करें?",
  ],

  outlineTitle: "रूपरेखा",
  outlineMore: "{n} और दिखाएँ",
  outlineRecapPrompt: "अंश {from}–{to} का सार: {title}",

  trackListAddAllToPlaylist: "सभी को प्लेलिस्ट में जोड़ें",
  trackListAddAllDone: "{n} प्रवचन प्लेलिस्ट में जोड़े गए",
  trackListAddAllPartial: "{added} जोड़े गए, {failed} विफल",
  trackListAddAllFailed: "प्रवचन प्लेलिस्ट में नहीं जोड़े जा सके।",
  actionOpenLibrary: "खोलें",
  actionOpenNotes: "खोलें",
  miniRowOpen: "प्रवचन खोलें",

  noteSaved: "नोट सहेजा गया",
  noteSaving: "नोट सहेज रहा हूँ…",
  actionNoteError: "नोट सहेजा नहीं जा सका।",

  actionPdfKind: "प्रवचन की प्रतिलिपि",
  actionPdfShare: "साझा करें",
  actionPdfShared: "भेज दिया",
  actionPdfError: "PDF तैयार नहीं हो सका।",
  actionPdfDialog: "प्रतिलिपि साझा करें",

  actionDismiss: "छोड़ें",
  actionDismissed: "खारिज किया गया",
  actionRetry: "फिर कोशिश करें",
  actionDegraded: "एक्शन कार्ड डेटा गायब है।",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "संदेश कॉपी करें",
  copyDone: "कॉपी किया गया",
  /** Aria-label for the inline message Share button. */
  shareAction: "संदेश साझा करें",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "अच्छा उत्तर",
    thumbsDown: "खराब उत्तर",
    thanks: "प्रतिक्रिया के लिए धन्यवाद",
    failed: "प्रतिक्रिया नहीं भेजी जा सकी — फिर कोशिश करें",
    sheet: {
      title: "क्या गड़बड़ थी?",
      hint: "सभी फ़ील्ड वैकल्पिक हैं। भेजने के लिए सबमिट दबाएँ।",
      categoryLabel: "प्रकार",
      categoryPlaceholder: "कोई एक चुनें (वैकल्पिक)",
      commentLabel: "टिप्पणी",
      commentPlaceholder: "और कुछ? (वैकल्पिक)",
      submit: "सबमिट करें",
    },
    categories: {
      off_topic: "विषय से बाहर",
      no_results: "कुछ नहीं मिला",
      bad_citations: "खराब उद्धरण",
      wrong_language: "गलत भाषा",
      factually_wrong: "तथ्यात्मक रूप से गलत",
      other: "अन्य",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "दैनिक अनुस्मारक",
  proactiveSessionTitleSmartLibrary: "स्मार्ट लाइब्रेरी",
  proactiveSessionTitleNextShloka: "अगले श्लोक पर प्रवचन",
  proactiveSessionTitleUnfinishedLecture: "अधूरा प्रवचन",
  proactiveSessionTitleInactivity: "अपनी साधना पर लौटें",
  proactiveSessionTitleWeeklyDigest: "आपका सप्ताह",
  proactiveInactivityWelcomeBody:
    "काफ़ी समय बीत गया। ताज़ा प्रवचन आपका इंतज़ार कर रहे हैं — अपनी लाइब्रेरी खोलें और जहाँ छोड़ा था वहीं से आगे बढ़ें।",

  // Weekly-digest proactive session — a short rollup of the past week's
  // listening. `{count}` in `weeklyDigestMore` is the overflow count.
  weeklyDigestTitle: "आपका सप्ताह",
  weeklyDigestIntro: "यहाँ देखें आपका सप्ताह कैसा रहा 🙏",
  weeklyDigestTotalTime: "कुल सुनने का समय",
  weeklyDigestLectures: "इस सप्ताह के प्रवचन",
  weeklyDigestStreak: "लगातार दिन",
  weeklyDigestCompleted: "पूर्ण",
  weeklyDigestEmpty: "इस सप्ताह आपने कुछ नहीं सुना — लय में लौटने के लिए कोई ताज़ा प्रवचन चुनें।",
  weeklyDigestMore: "+{count} और",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "आप पिछले श्लोक पर थे — क्रम से आगे बढ़ते रहें। अगला यहाँ है: {ref} “{title}”। इसे अपनी लाइब्रेरी में जोड़ें?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "आपने “{title}” शुरू किया था पर पूरा नहीं किया। जहाँ छोड़ा था वहीं से जारी रखना चाहेंगे?",

  proactiveSmartLibraryHintBody:
    "मैं आपको स्मार्ट लाइब्रेरी दिखाना चाहता हूँ — यह एक Pro सुविधा है जो आपकी लाइब्रेरी को बिना हाथ से कुछ जोड़े ही ताज़ा प्रवचनों से भरी रखती है।\n\nआप मापदंड चुनते हैं — पसंदीदा वक्ता, विषय, स्रोत, प्रवचन की अवधि — और स्मार्ट लाइब्रेरी चुपचाप मेल खाते प्रवचनों को एक लक्षित कतार अवधि (जैसे 2 घंटे, 8 घंटे, 10 घंटे) तक आपकी लाइब्रेरी में लाती रहती है। जब कोई प्रवचन पूरा हो जाता है तो वह अपने आप संग्रहित हो जाता है, जिससे कतार ताज़ा बनी रहती है।\n\nयात्रा और सैर के लिए अच्छा है, जब आप यह चुनने में समय नहीं लगाना चाहते कि आगे क्या सुनें।",
  proactiveEnableNotificationsBody:
    "आप कुछ दिनों से लगातार सुन रहे हैं — अच्छी लय है। मैं सुझाव देता हूँ कि आप एक दैनिक अनुस्मारक सेट कर लें ताकि यह लय बनी रहे।\n\nयह आपके चुने समय पर एक कोमल स्थानीय सूचना है (मैं 07:00 से शुरू करूँगा, आप इसे सेटिंग्स में कभी भी बदल सकते हैं)। नेटवर्क पर कोई शोर नहीं — यह आपके डिवाइस पर ही रहती है और समय आने पर ही सक्रिय होती है।\n\nएक दैनिक सहारे के रूप में उपयोगी: एक छोटी-सी याद कि जब भी आपका दिन अनुमति दे, प्रवचन प्रतीक्षा कर रहा है।",

  actionEnableReminderTitle: "दैनिक अनुस्मारक",
  actionEnableReminderBody:
    "हर दिन का एक समय चुनें और मैं आपको सुनने आने की याद दिलाऊँगा। आप इसे बाद में सेटिंग्स में बदल या बंद कर सकते हैं।",
  actionEnableReminderConfirm: "चालू करें",
  actionEnableReminderDone: "दैनिक अनुस्मारक सेट हो गया।",
  actionEnableReminderError: "सूचनाएँ चालू नहीं की जा सकीं।",

  actionConfigureSmartLibraryTitle: "स्मार्ट लाइब्रेरी",
  actionConfigureSmartLibraryBody:
    "अपने विषयों पर ताज़ा प्रवचन ऑफ़लाइन कतार में रखें। मैं ये फ़िल्टर आपके लिए पहले से भर सकता हूँ।",
  actionConfigureSmartLibraryConfirm: "सेट अप करें",
  actionConfigureSmartLibraryDone: "सेटिंग्स में खोला गया।",
  actionConfigureSmartLibraryError: "स्मार्ट लाइब्रेरी नहीं खुल सकी।",
  actionConfigureSmartLibraryChipAuthors: "{n} वक्ता",
  actionConfigureSmartLibraryChipTopics: "{n} विषय",
  actionConfigureSmartLibraryChipSources: "{n} स्रोत",
  actionConfigureSmartLibraryChipLocations: "{n} स्थान",
  actionConfigureSmartLibraryChipLanguages: "{n} भाषाएँ",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "स्मार्ट लाइब्रेरी, Notes Studio और बाकी Pro सुविधाओं को अनलॉक करें और ऐप का पूरा लाभ उठाएँ।",
  actionUpgradeToProConfirm: "Pro देखें",
  actionUpgradeToProDone: "सब्सक्रिप्शन पेज खुल गया।",
  actionUpgradeToProError: "अपग्रेड स्क्रीन नहीं खुल सकी।",

  actionQueueNextTrackTitle: "लाइब्रेरी में जोड़ें",
  actionQueueNextTrackConfirm: "जोड़ें",
  actionQueueNextTrackDone: "लाइब्रेरी में जोड़ा गया।",
  actionQueueNextTrackError: "यह प्रवचन नहीं जोड़ा जा सका।",

  citationSaveAsNote: "नोट के रूप में सहेजें",
  citationOpenInStudio: "Studio में खोलें",
  citationAddLectureToPlaylist: "प्रवचन को प्लेलिस्ट में जोड़ें",
  recentSessionsLabel: "हाल की चैट",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "अभी-अभी",
  timeYesterday: "कल",
  timeUnitMinute: "मि",
  timeUnitHour: "घं",
  timeUnitDay: "दि",
  timeUnitWeek: "सप्ताह",
  timeUnitMonth: "माह",
  timeUnitYear: "वर्ष",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "सोच रहा हूँ…",
    searching_corpus: "रिकॉर्डिंग्स में खोज रहा हूँ…",
    composing_answer: "उत्तर लिख रहा हूँ…",
    preparing_action: "तैयार कर रहा हूँ…",
    browsing_catalog: "कैटलॉग देख रहा हूँ…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "प्रश्न चुन रहा हूँ…",
  },
}
