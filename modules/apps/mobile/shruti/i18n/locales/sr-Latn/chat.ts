export default {
  title: "Ćaskanje",
  placeholder: "Postavite pitanje",
  send: "Pošalji",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Zaustavi",
  sending: "Razmišljam…",
  emptyStateTitle: "Kako mogu da pomognem?",
  emptyState: "Pitajte bilo šta — potražiću u snimcima.",
  newSession: "Novo ćaskanje",
  history: "Istorija ćaskanja",
  historyEmpty: "Još nema nijednog ćaskanja.",
  searchPlaceholder: "Pretraži istoriju",
  searchEmpty: "Nema rezultata",
  untitledSession: "Bez naslova",
  clearHistory: "Obriši istoriju ćaskanja",
  clearHistoryConfirm: "Obrisati sva ćaskanja i poruke? Ova radnja se ne može poništiti.",
  clearedToast: "Istorija ćaskanja je obrisana.",
  citationActionHeader: "Otvori citat",
  citationOpen: "Otvori predavanje",
  citationListen: "Preslušaj isečak",
  citationLoading: "Učitavam…",
  citationOpenFull: "Otvori celo predavanje",
  citationDetailsTitle: "Detalji citata",
  citationNoAudio: "Audio za ovaj citat nije dostupan",
  citationLoadFailed: "Nije moguće učitati isečak",
  citationAddedToPlaylist: "Dodato na listu numera",
  citationAddFailed: "Nije moguće dodati na listu numera",
  citationMtBadge: "Automatski prevedeno",
  citationViewOriginal: "Prikaži original",
  citationViewTranslated: "Prikaži prevod",
  lectureCardMissing: "Predavanje nije dostupno u lokalnom katalogu.",
  errRate: "Previše zahteva. Pokušajte za minut.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Previše zahteva. Pokušajte {when}.",
  errNetwork: "Nije moguće povezati se sa ćaskanjem. Proverite vezu.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Nema interneta",
    body: "Pokušaćemo ponovo čim se vratite na mrežu.",
    cta: "Pokušaj ponovo (automatski)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Server nije dostupan",
    body: "Pokušajte za trenutak.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Ćaskanje je privremeno nedostupno",
    body: "Trenutno nismo mogli da pošaljemo poruku. Pokušajte malo kasnije.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Ograničenje zahteva",
  errQuotaUnknownBody: "Dnevno ograničenje je dostignuto, pokušajte kasnije.",
  errServiceNotReady: "Servis ćaskanja se pokreće. Pokušajte uskoro.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Servis ćaskanja je vratio grešku. Pokušajte malo kasnije.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Autorizacija nije uspela. Ponovo pokrenite aplikaciju.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Ova verzija aplikacije više nije podržana. Ažurirajte je.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Potrebno ažuriranje",
      body: "Ćaskanje koristi novi protokol. Ažurirajte Shruti da biste nastavili.",
      cta: "Otvori prodavnicu",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Privremeni prekid",
      body: "Pokušajte za trenutak.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "Veza je prekinuta pre nego što je odgovor stigao.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Nije moguće dobiti odgovor.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Nije moguće sastaviti odgovor. Pokušajte sa konkretnijim pitanjem.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (prekinuto — veza je izgubljena)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (zaustavljeno — previše poziva alata)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (zaustavljeno)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "za {n} s",
  retryInMinutes: "za {n} min",
  retryAtTime: "u {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "sutra u {time}",
  retryNow: "sada",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Dnevno ograničenje poruka je dostignuto",
  errQuotaAnonBody: "Prijavite se da dobijete više poruka dnevno. Obnavlja se {when}.",
  errQuotaFreeTitle: "Dnevno ograničenje poruka je dostignuto",
  errQuotaFreeBody: "Shruti Pro ukida dnevno ograničenje poruka. Obnavlja se {when}.",
  errQuotaProTitle: "Dnevno ograničenje je dostignuto",
  errQuotaProBody: "Iskoristili ste današnje poruke u ćaskanju. Obnavlja se {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Prijavi se",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Dnevno ograničenje je dostignuto — pokušajte kasnije",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Pisanje je pauzirano, dnevno ograničenje se obnavlja {when}",
  composeLimitedAriaLabelNoTime: "Pisanje je pauzirano, dnevno ograničenje je dostignuto",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% iskorišćeno · obnavlja se {date} u {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Sažetak trenutnog predavanja",
  suggestionRecapRecent: "Sažetak poslednjeg predavanja",
  followupAriaLabel: "Predloženo pitanje: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Šta znači ovaj odlomak?",
    "Objasni jednostavnim rečima",
    "Daj mi više konteksta",
    "Iz kog je ovo spisa?",
  ],
  suggestions: [
    "Gde sam stao?", // user_tracks_list(status='in_progress')
    "Lista po Giti, pogl. 2", // propose_playlist
    "Predavanja o BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Šta sam slušao ove nedelje", // user_tracks_list(since=now-7d)
    "Šta dalje da slušam?", // user_recommendations_get
    "O bhakti", // chunks_search (semantic)
    "Šta je duša?", // chunks_search (semantic)
    "Jutarnje šetnje u Bombaju", // list_tracks(location=Bombay, tag=morning_walk)
    "Razgovori u Vrindavanu", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF poslednjeg predavanja", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Ko je Krišna?",
    "Zašto patimo?",
    "Šta je karma?",
    "Šta je reinkarnacija?",
    "Zašto pevati mantru?",
    "Šta je bhakti?",
    "Ko je guru?",
    "Zašto čitati „Bhagavad-gītu“?",
    "Zašto vegetarijanstvo?",
    "Šta je smisao života?",
    "Šta se dešava posle smrti?",
    "Šta je dharma?",
    "Ko je Šrila Prabhupada?",
    "Odakle da počnem praksu?",
    "Kako razviti ljubav prema Bogu?",
    "Šta je sveto ime?",
    "Kako meditirati na Krišnu?",
  ],

  outlineTitle: "Plan",
  outlineMore: "Prikaži još {n}",
  outlineRecapPrompt: "Sažetak segmenta {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Dodaj sve na listu numera",
  trackListAddAllDone: "{n} predavanja dodato na listu numera",
  trackListAddAllPartial: "{added} dodato, {failed} neuspešno",
  trackListAddAllFailed: "Nije moguće dodati predavanja na listu numera.",
  actionOpenLibrary: "Otvori",
  actionOpenNotes: "Otvori",
  miniRowOpen: "Otvori predavanje",

  noteSaved: "Beleška je sačuvana",
  noteSaving: "Čuvam belešku…",
  actionNoteError: "Nije moguće sačuvati belešku.",

  actionPdfKind: "Transkript predavanja",
  actionPdfShare: "Podeli",
  actionPdfShared: "Poslato",
  actionPdfError: "Nije moguće pripremiti PDF.",
  actionPdfDialog: "Podeli transkript",

  actionDismiss: "Preskoči",
  actionDismissed: "Odbačeno",
  actionRetry: "Pokušaj ponovo",
  actionDegraded: "Podaci kartice radnje nedostaju.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Kopiraj poruku",
  copyDone: "Kopirano",
  /** Aria-label for the inline message Share button. */
  shareAction: "Podeli poruku",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Dobar odgovor",
    thumbsDown: "Loš odgovor",
    thanks: "Hvala na povratnoj informaciji",
    failed: "Nije moguće poslati povratnu informaciju — pokušajte ponovo",
    sheet: {
      title: "Šta je bilo pogrešno?",
      hint: "Sva polja su opciona. Dodirnite „Pošalji“ za slanje.",
      categoryLabel: "Vrsta",
      categoryPlaceholder: "Izaberite jednu (opciono)",
      commentLabel: "Komentar",
      commentPlaceholder: "Još nešto? (opciono)",
      submit: "Pošalji",
    },
    categories: {
      off_topic: "Van teme",
      no_results: "Ništa nije pronađeno",
      bad_citations: "Loši citati",
      wrong_language: "Pogrešan jezik",
      factually_wrong: "Činjenično netačno",
      other: "Drugo",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Dnevni podsetnik",
  proactiveSessionTitleSmartLibrary: "Pametna biblioteka",
  proactiveSessionTitleNextShloka: "Predavanje o sledećem stihu",
  proactiveSessionTitleUnfinishedLecture: "Nedovršeno predavanje",
  proactiveSessionTitleInactivity: "Vratite se svojoj praksi",
  proactiveSessionTitleWeeklyDigest: "Vaša nedelja",
  proactiveInactivityWelcomeBody:
    "Dugo vas nije bilo. Sveža predavanja vas čekaju — otvorite biblioteku i nastavite odakle ste stali.",

  // Weekly digest — proactive recap of the user's listening week.
  weeklyDigestTitle: "Vaša nedelja",
  weeklyDigestIntro: "Evo kako je protekla tvoja nedelja 🙏",
  weeklyDigestTotalTime: "Ukupno vreme slušanja",
  weeklyDigestLectures: "Predavanja ove nedelje",
  weeklyDigestStreak: "Niz dana",
  weeklyDigestCompleted: "Završeno",
  weeklyDigestEmpty: "Ove nedelje niste slušali — izaberite nešto sveže da se vratite u ritam.",
  weeklyDigestMore: "+{count} još",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Bili ste na prethodnom stihu — nastavite po redu. Sledeći je ovde: {ref} „{title}“. Da ga dodam u vašu biblioteku?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Započeli ste „{title}“, ali ga niste dovršili. Želite li da nastavite odakle ste stali?",

  proactiveSmartLibraryHintBody:
    "Želeo bih da vam pokažem Pametnu biblioteku — Pro funkciju koja vašu biblioteku drži punu svežih predavanja, bez potrebe da bilo šta ručno dodajete.\n\nVi birate kriterijume — omiljene autore, teme, izvore, dužinu predavanja — a Pametna biblioteka tiho dovlači odgovarajuća predavanja do ciljne dužine reda (npr. 2 sata, 8 sati, 10 sati). Kada se nešto završi, automatski se arhivira, pa red ostaje svež.\n\nKorisno za putovanja i šetnje, kada ne želite da gubite vreme birajući šta dalje da slušate.",
  proactiveEnableNotificationsBody:
    "Slušate nekoliko dana zaredom — lep ritam. Želeo bih da predložim podešavanje dnevnog podsetnika da ga ne biste izgubili.\n\nTo je jedno nežno lokalno obaveštenje u vreme koje izaberete (počeću sa 07:00, možete ga promeniti bilo kada u Podešavanjima). Nema opterećenja mreže — živi na vašem uređaju i oglašava se samo kada dođe vreme.\n\nKorisno kao dnevno sidro: mali podsticaj da vas predavanje čeka kad god vam dan dozvoli.",

  actionEnableReminderTitle: "Dnevni podsetnik",
  actionEnableReminderBody:
    "Izaberite vreme svakog dana i podsetiću vas da dođete da slušate. Kasnije možete promeniti ili isključiti u Podešavanjima.",
  actionEnableReminderConfirm: "Uključi",
  actionEnableReminderDone: "Dnevni podsetnik je podešen.",
  actionEnableReminderError: "Nije moguće omogućiti obaveštenja.",

  actionConfigureSmartLibraryTitle: "Pametna biblioteka",
  actionConfigureSmartLibraryBody:
    "Držite sveža predavanja o vašim temama u redu, oflajn. Mogu da vam unapred popunim ove filtere.",
  actionConfigureSmartLibraryConfirm: "Podesi",
  actionConfigureSmartLibraryDone: "Otvoreno u Podešavanjima.",
  actionConfigureSmartLibraryError: "Nije moguće otvoriti Pametnu biblioteku.",
  actionConfigureSmartLibraryChipAuthors: "{n} autora",
  actionConfigureSmartLibraryChipTopics: "{n} tema",
  actionConfigureSmartLibraryChipSources: "{n} izvora",
  actionConfigureSmartLibraryChipLocations: "{n} lokacija",
  actionConfigureSmartLibraryChipLanguages: "{n} jezika",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Otključajte Pametnu biblioteku, Studio za beleške i ostatak Pro paketa da izvučete najviše iz aplikacije.",
  actionUpgradeToProConfirm: "Pogledaj Pro",
  actionUpgradeToProDone: "Stranica pretplate je otvorena.",
  actionUpgradeToProError: "Nije moguće otvoriti ekran nadogradnje.",

  actionQueueNextTrackTitle: "Dodaj u biblioteku",
  actionQueueNextTrackConfirm: "Dodaj",
  actionQueueNextTrackDone: "Dodato u biblioteku.",
  actionQueueNextTrackError: "Nije moguće dodati ovo predavanje.",

  citationSaveAsNote: "Sačuvaj kao belešku",
  citationOpenInStudio: "Otvori u Studiju",
  citationAddLectureToPlaylist: "Dodaj predavanje na listu numera",
  recentSessionsLabel: "Nedavna ćaskanja",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "upravo sada",
  timeYesterday: "juče",
  timeUnitMinute: "min",
  timeUnitHour: "č",
  timeUnitDay: "d",
  timeUnitWeek: "ned",
  timeUnitMonth: "mes",
  timeUnitYear: "g",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Razmišljam…",
    searching_corpus: "Pretražujem snimke…",
    composing_answer: "Pišem odgovor…",
    preparing_action: "Pripremam…",
    browsing_catalog: "Pregledam katalog…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Biram pitanja…",
  },
}
