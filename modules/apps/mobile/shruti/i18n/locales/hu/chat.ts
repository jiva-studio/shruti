export default {
  title: "Csevegés",
  placeholder: "Tegyél fel egy kérdést",
  send: "Küldés",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Leállítás",
  sending: "Gondolkodom…",
  emptyStateTitle: "Miben segíthetek?",
  emptyState: "Kérdezz bármit — megkeresem a felvételekben.",
  newSession: "Új csevegés",
  history: "Csevegési előzmények",
  historyEmpty: "Még nincsenek korábbi csevegések.",
  searchPlaceholder: "Keresés az előzményekben",
  searchEmpty: "Nincs találat",
  untitledSession: "Névtelen csevegés",
  clearHistory: "Csevegési előzmények törlése",
  clearHistoryConfirm: "Törlöd az összes csevegést és üzenetet? Ezt nem lehet visszavonni.",
  clearedToast: "Csevegési előzmények törölve.",
  citationActionHeader: "Idézet megnyitása",
  citationOpen: "Előadás megnyitása",
  citationListen: "Részlet meghallgatása",
  citationLoading: "Betöltés…",
  citationOpenFull: "Teljes előadás megnyitása",
  citationDetailsTitle: "Idézet részletei",
  citationNoAudio: "Ehhez az idézethez nem érhető el hang",
  citationLoadFailed: "Nem sikerült betölteni a részletet",
  citationAddedToPlaylist: "Hozzáadva a lejátszási listához",
  citationAddFailed: "Nem sikerült hozzáadni a lejátszási listához",
  citationMtBadge: "Automatikusan lefordítva",
  citationViewOriginal: "Eredeti megjelenítése",
  citationViewTranslated: "Fordítás megjelenítése",
  lectureCardMissing: "Az előadás nem érhető el a helyi katalógusban.",
  errRate: "Túl sok kérés. Próbáld újra egy perc múlva.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Túl sok kérés. Próbáld újra {when}.",
  errNetwork: "Nem sikerült elérni a csevegőszolgáltatást. Ellenőrizd a kapcsolatot.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Nincs internet",
    body: "Újrapróbálom, amint újra elérhető a hálózat.",
    cta: "Újra (automatikus)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "A szerver nem elérhető",
    body: "Próbáld újra egy pillanat múlva.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "A csevegés átmenetileg nem elérhető",
    body: "Most nem sikerült elküldeni az üzenetedet. Kérlek, próbáld újra kicsit később.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Kéréskorlát",
  errQuotaUnknownBody: "Elérted a napi korlátot, próbáld újra később.",
  errServiceNotReady: "A csevegőszolgáltatás éppen indul. Próbáld újra hamarosan.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "A csevegőszolgáltatás hibát adott vissza. Próbáld újra hamarosan.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Az engedélyezés nem sikerült. Indítsd újra az alkalmazást.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Ez az alkalmazásverzió már nem támogatott. Kérlek, frissítsd.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Frissítés szükséges",
      body: "A csevegés új protokollt használ. Frissítsd a Shrutiot a folytatáshoz.",
      cta: "Áruház megnyitása",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Átmeneti üzemzavar",
      body: "Próbáld újra egy pillanat múlva.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "A kapcsolat megszakadt, mielőtt a válasz megérkezett volna.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Nem sikerült választ kapni.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Nem sikerült összeállítani a választ. Próbálj célzottabb kérdést.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (megszakadt — a kapcsolat elveszett)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (leállt — túl sok eszközhívás)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (leállítva)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "{n} mp múlva",
  retryInMinutes: "{n} perc múlva",
  retryAtTime: "{time}-kor",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "holnap {time}-kor",
  retryNow: "most",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Elérted a napi üzenetkorlátot",
  errQuotaAnonBody: "Jelentkezz be, hogy több napi üzenetet kapj. Visszaáll {when}.",
  errQuotaFreeTitle: "Elérted a napi üzenetkorlátot",
  errQuotaFreeBody: "A Shruti Pro feloldja a napi üzenetkorlátot. Visszaáll {when}.",
  errQuotaProTitle: "Elérted a napi korlátot",
  errQuotaProBody: "Mára elfogytak a csevegési üzeneteid. Visszaáll {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Bejelentkezés",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Elérted a napi korlátot — próbáld újra később",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "A beírás szünetel, a napi korlát visszaáll {when}",
  composeLimitedAriaLabelNoTime: "A beírás szünetel, elérted a napi korlátot",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% felhasználva · visszaáll {date} {time}-kor",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Aktuális előadás összefoglalása",
  suggestionRecapRecent: "Utolsó előadás összefoglalása",
  followupAriaLabel: "Javasolt folytatás: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Mit jelent ez a részlet?",
    "Magyarázd el egyszerűen",
    "Adj több hátteret",
    "Melyik szentírásból van ez?",
  ],
  suggestions: [
    "Hol hagytam abba?", // user_tracks_list(status='in_progress')
    "Lejátszási lista a Gítá 2-ről", // propose_playlist
    "Előadások a BG 2.11–20-ról", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Mit hallgattam a héten", // user_tracks_list(since=now-7d)
    "Mit hallgassak ezután?", // user_recommendations_get
    "A bhaktiról", // chunks_search (semantic)
    "Mi a lélek?", // chunks_search (semantic)
    "Bombayi reggeli séták", // list_tracks(location=Bombay, tag=morning_walk)
    "Vrindávani beszélgetések", // list_tracks(location=Vrindavan, tag=conversation)
    "Az utolsó előadás PDF-je", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Ki Krisna?",
    "Miért szenvedünk?",
    "Mi a karma?",
    "Mi a reinkarnáció?",
    "Miért zengjük a mantrát?",
    "Mi a bhakti?",
    "Ki a guru?",
    "Miért olvassuk a Bhagavad-gītāt?",
    "Miért vegetáriánus életmód?",
    "Mi az élet értelme?",
    "Mi történik a halál után?",
    "Mi a dharma?",
    "Ki Śrīla Prabhupāda?",
    "Hol kezdjem a gyakorlást?",
    "Hogyan fejlesszem ki az Isten iránti szeretetet?",
    "Mi a szent név?",
    "Hogyan meditáljak Krisnán?",
  ],

  outlineTitle: "Vázlat",
  outlineMore: "Még {n} megjelenítése",
  outlineRecapPrompt: "{from}–{to} szakasz összefoglalása: {title}",

  trackListAddAllToPlaylist: "Összes hozzáadása a lejátszási listához",
  trackListAddAllDone: "{n} előadás hozzáadva a lejátszási listához",
  trackListAddAllPartial: "{added} hozzáadva, {failed} sikertelen",
  trackListAddAllFailed: "Nem sikerült hozzáadni az előadásokat a lejátszási listához.",
  actionOpenLibrary: "Megnyitás",
  actionOpenNotes: "Megnyitás",
  miniRowOpen: "Előadás megnyitása",

  noteSaved: "Jegyzet mentve",
  noteSaving: "Jegyzet mentése…",

  actionPdfKind: "Előadás-átirat",
  actionPdfShare: "Megosztás",
  actionPdfShared: "Elküldve",
  actionPdfError: "Nem sikerült elkészíteni a PDF-et.",
  actionPdfDialog: "Átirat megosztása",

  actionDismiss: "Kihagyás",
  actionDismissed: "Elvetve",
  actionRetry: "Újra",
  actionDegraded: "Hiányoznak a műveleti kártya adatai.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Üzenet másolása",
  copyDone: "Másolva",
  /** Aria-label for the inline message Share button. */
  shareAction: "Üzenet megosztása",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Jó válasz",
    thumbsDown: "Rossz válasz",
    thanks: "Köszönjük a visszajelzést",
    failed: "Nem sikerült elküldeni — próbáld újra",
    sheet: {
      title: "Mi volt a baj?",
      hint: "Minden mező elhagyható. A küldéshez koppints a Beküldés gombra.",
      categoryLabel: "Típus",
      categoryPlaceholder: "Válassz egyet (elhagyható)",
      commentLabel: "Megjegyzés",
      commentPlaceholder: "Bármi más? (elhagyható)",
      submit: "Beküldés",
    },
    categories: {
      off_topic: "Témán kívüli",
      no_results: "Nincs találat",
      bad_citations: "Rossz idézetek",
      wrong_language: "Rossz nyelv",
      factually_wrong: "Tárgyilag helytelen",
      other: "Egyéb",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Napi emlékeztető",
  proactiveSessionTitleSmartLibrary: "Okos könyvtár",
  proactiveSessionTitleNextShloka: "Előadás a következő versről",
  proactiveSessionTitleUnfinishedLecture: "Befejezetlen előadás",
  proactiveSessionTitleInactivity: "Térj vissza a gyakorlásodhoz",
  proactiveSessionTitleWeeklyDigest: "A heted",
  proactiveInactivityWelcomeBody:
    "Rég jártál itt. Friss előadások várnak — nyisd meg a könyvtáradat, és folytasd ott, ahol abbahagytad.",

  // Weekly digest — proactive summary of the past week's listening.
  weeklyDigestTitle: "A heted",
  weeklyDigestTotalTime: "Összes hallgatási idő",
  weeklyDigestLectures: "Előadások a héten",
  weeklyDigestStreak: "Napos sorozat",
  weeklyDigestCompleted: "Befejezve",
  weeklyDigestEmpty:
    "Ezen a héten nem hallgattál semmit — válassz valami frisset, hogy visszatalálj a ritmusba.",
  weeklyDigestMore: "+{count} további",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Az előző versnél tartottál — folytasd sorban. A következő itt van: {ref} „{title}”. Hozzáadod a könyvtáradhoz?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Elkezdted a(z) „{title}” előadást, de nem fejezted be. Folytatod onnan, ahol abbahagytad?",

  proactiveSmartLibraryHintBody:
    "Szeretném megmutatni neked az Okos könyvtárat — ez egy Pro funkció, amely friss előadásokkal tartja tele a könyvtáradat anélkül, hogy bármit kézzel kellene a sorba tenned.\n\nTe választod ki a feltételeket — kedvenc szerzők, témák, források, előadáshossz —, az Okos könyvtár pedig csendben behúzza a megfelelő előadásokat egy célzott sorhosszig (pl. 2 óra, 8 óra, 10 óra). Ha valamit befejeztél, az automatikusan archívumba kerül, így a sor friss marad.\n\nJó az ingázáshoz és a sétákhoz, amikor nem akarsz azzal időt tölteni, hogy mit hallgass legközelebb.",
  proactiveEnableNotificationsBody:
    "Néhány napja egymás után hallgatsz — szép ritmus. Javaslom, állíts be egy napi emlékeztetőt, hogy ne veszítsd el.\n\nEz egy szelíd helyi értesítés az általad választott időpontban (07:00-kal kezdem, bármikor megváltoztathatod a Beállításokban). Semmi hálózati zaj — az eszközödön él, és csak akkor szólal meg, amikor eljön az idő.\n\nHasznos napi horgonyként: egy apró figyelmeztetés, hogy az előadás vár, amikor a napod engedi.",

  actionEnableReminderTitle: "Napi emlékeztető",
  actionEnableReminderBody:
    "Válassz egy időpontot minden napra, és emlékeztetlek, hogy gyere hallgatni. Később bármikor megváltoztathatod vagy kikapcsolhatod a Beállításokban.",
  actionEnableReminderConfirm: "Bekapcsolás",
  actionEnableReminderDone: "A napi emlékeztető beállítva.",
  actionEnableReminderError: "Nem sikerült engedélyezni az értesítéseket.",

  actionConfigureSmartLibraryTitle: "Okos könyvtár",
  actionConfigureSmartLibraryBody:
    "Tartsd a témáidhoz illő friss előadásokat offline a sorban. Előre beállíthatom neked ezeket a szűrőket.",
  actionConfigureSmartLibraryConfirm: "Beállítás",
  actionConfigureSmartLibraryDone: "Megnyitva a Beállításokban.",
  actionConfigureSmartLibraryError: "Nem sikerült megnyitni az Okos könyvtárat.",
  actionConfigureSmartLibraryChipAuthors: "{n} szerző",
  actionConfigureSmartLibraryChipTopics: "{n} téma",
  actionConfigureSmartLibraryChipSources: "{n} forrás",
  actionConfigureSmartLibraryChipLocations: "{n} helyszín",
  actionConfigureSmartLibraryChipLanguages: "{n} nyelv",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Oldd fel az Okos könyvtárat, a Jegyzetstúdiót és a Pro többi funkcióját, hogy a legtöbbet hozd ki az alkalmazásból.",
  actionUpgradeToProConfirm: "Pro megtekintése",
  actionUpgradeToProDone: "Az előfizetési ablak megnyílt.",
  actionUpgradeToProError: "Nem sikerült megnyitni a frissítési képernyőt.",

  actionQueueNextTrackTitle: "Hozzáadás a könyvtárhoz",
  actionQueueNextTrackConfirm: "Hozzáadás",
  actionQueueNextTrackDone: "Hozzáadva a könyvtárhoz.",
  actionQueueNextTrackError: "Nem sikerült hozzáadni ezt az előadást.",

  citationSaveAsNote: "Mentés jegyzetként",
  citationOpenInStudio: "Megnyitás a Stúdióban",
  citationAddLectureToPlaylist: "Előadás hozzáadása a lejátszási listához",
  recentSessionsLabel: "Legutóbbi csevegések",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "épp most",
  timeYesterday: "tegnap",
  timeUnitMinute: "p",
  timeUnitHour: "ó",
  timeUnitDay: "n",
  timeUnitWeek: "hét",
  timeUnitMonth: "hó",
  timeUnitYear: "é",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Gondolkodom…",
    searching_corpus: "Keresés a felvételekben…",
    composing_answer: "A válasz megírása…",
    preparing_action: "Előkészítés…",
    browsing_catalog: "Katalógus böngészése…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Kérdések kiválasztása…",
  },
}
