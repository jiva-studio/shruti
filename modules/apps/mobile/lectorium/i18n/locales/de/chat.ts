export default {
  title: "Chat",
  placeholder: "Stelle eine Frage",
  send: "Senden",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Stopp",
  sending: "Ich denke nach…",
  emptyStateTitle: "Wie kann ich helfen?",
  emptyState: "Frag mich etwas — ich suche es in den Aufnahmen.",
  newSession: "Neuer Chat",
  history: "Chatverlauf",
  historyEmpty: "Noch keine früheren Chats.",
  searchPlaceholder: "Verlauf durchsuchen",
  searchEmpty: "Keine Treffer",
  untitledSession: "Ohne Titel",
  clearHistory: "Chatverlauf löschen",
  clearHistoryConfirm:
    "Alle Chats und Nachrichten löschen? Das kann nicht rückgängig gemacht werden.",
  clearedToast: "Chatverlauf gelöscht.",
  citationActionHeader: "Zitat öffnen",
  citationOpen: "Vortrag öffnen",
  citationListen: "Ausschnitt anhören",
  citationLoading: "Lädt…",
  citationOpenFull: "Vollständigen Vortrag öffnen",
  citationDetailsTitle: "Zitatdetails",
  citationNoAudio: "Für dieses Zitat ist kein Audio verfügbar",
  citationLoadFailed: "Ausschnitt konnte nicht geladen werden",
  citationAddedToPlaylist: "Zur Playlist hinzugefügt",
  citationAddFailed: "Konnte nicht zur Playlist hinzugefügt werden",
  citationMtBadge: "Automatisch übersetzt",
  citationViewOriginal: "Original anzeigen",
  citationViewTranslated: "Übersetzung anzeigen",
  lectureCardMissing: "Vortrag im lokalen Katalog nicht verfügbar.",
  errRate: "Zu viele Anfragen. Versuche es in einer Minute erneut.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Zu viele Anfragen. Versuche es {when} erneut.",
  errNetwork: "Der Chatdienst konnte nicht erreicht werden. Prüfe deine Verbindung.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Keine Internetverbindung",
    body: "Wird automatisch wiederholt, sobald du wieder online bist.",
    cta: "Wiederholen (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Server nicht erreichbar",
    body: "Versuche es gleich erneut.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Chat ist vorübergehend nicht verfügbar",
    body: "Deine Nachricht konnte gerade nicht gesendet werden. Bitte versuche es etwas später erneut.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Anfragelimit",
  errQuotaUnknownBody: "Tageslimit erreicht, versuche es später erneut.",
  errServiceNotReady: "Der Chatdienst startet gerade. Versuche es in Kürze erneut.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Der Chatdienst hat einen Fehler zurückgegeben. Versuche es in Kürze erneut.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Anmeldung fehlgeschlagen. Starte die App neu, um es erneut zu versuchen.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Diese App-Version wird nicht mehr unterstützt. Bitte aktualisiere sie.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Aktualisierung erforderlich",
      body: "Der Chat nutzt ein neues Protokoll. Aktualisiere Lectorium, um fortzufahren.",
      cta: "Store öffnen",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Vorübergehende Störung",
      body: "Versuche es gleich erneut.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "Die Verbindung wurde unterbrochen, bevor die Antwort eintraf.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Es konnte keine Antwort abgerufen werden.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Es konnte keine Antwort zusammengestellt werden. Versuche eine gezieltere Frage.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (abgebrochen — Verbindung unterbrochen)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (gestoppt — zu viele Tool-Aufrufe)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (gestoppt)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "in {n} Sek.",
  retryInMinutes: "in {n} Min.",
  retryAtTime: "um {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "morgen um {time}",
  retryNow: "jetzt",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Tägliches Nachrichtenlimit erreicht",
  errQuotaAnonBody:
    "Melde dich an, um mehr Chatnachrichten pro Tag zu erhalten. Wird {when} zurückgesetzt.",
  errQuotaFreeTitle: "Tägliches Nachrichtenlimit erreicht",
  errQuotaFreeBody:
    "Mit Shruti Pro entfällt das tägliche Nachrichtenlimit. Wird {when} zurückgesetzt.",
  errQuotaProTitle: "Tageslimit erreicht",
  errQuotaProBody: "Du hast die heutigen Chatnachrichten aufgebraucht. Wird {when} zurückgesetzt.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Anmelden",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Tageslimit erreicht — versuche es später erneut",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Eingabe pausiert, das Tageslimit wird {when} zurückgesetzt",
  composeLimitedAriaLabelNoTime: "Eingabe pausiert, Tageslimit erreicht",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% genutzt · Zurücksetzung {date} um {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Aktuellen Vortrag zusammenfassen",
  suggestionRecapRecent: "Letzten Vortrag zusammenfassen",
  followupAriaLabel: "Vorschlag zum Weiterfragen: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Was bedeutet dieser Abschnitt?",
    "Einfach erklärt",
    "Gib mir mehr Kontext",
    "Aus welcher Schrift stammt das?",
  ],
  suggestions: [
    "Wo bin ich stehengeblieben?", // user_tracks_list(status='in_progress')
    "Playlist zur Gītā Kap. 2", // propose_playlist
    "Vorträge zu BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Was ich diese Woche gehört habe", // user_tracks_list(since=now-7d)
    "Was als Nächstes hören?", // user_recommendations_get
    "Über Bhakti", // chunks_search (semantic)
    "Was ist die Seele?", // chunks_search (semantic)
    "Morgenspaziergänge in Bombay", // list_tracks(location=Bombay, tag=morning_walk)
    "Gespräche in Vṛndāvana", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF des letzten Vortrags", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Wer ist Kṛṣṇa?",
    "Warum leiden wir?",
    "Was ist Karma?",
    "Was ist Reinkarnation?",
    "Warum die Mantra chanten?",
    "Was ist Bhakti?",
    "Wer ist ein Guru?",
    "Warum die Bhagavad-gītā lesen?",
    "Warum Vegetarismus?",
    "Was ist der Sinn des Lebens?",
    "Was geschieht nach dem Tod?",
    "Was ist Dharma?",
    "Wer ist Śrīla Prabhupāda?",
    "Womit beginne ich die Praxis?",
    "Wie entwickelt man Liebe zu Gott?",
    "Was ist der heilige Name?",
    "Wie meditiert man über Kṛṣṇa?",
  ],

  outlineTitle: "Gliederung",
  outlineMore: "{n} weitere anzeigen",
  outlineRecapPrompt: "Abschnitt {from}–{to} zusammenfassen: {title}",

  trackListAddAllToPlaylist: "Alle zur Playlist hinzufügen",
  trackListAddAllDone: "{n} Vorträge zur Playlist hinzugefügt",
  trackListAddAllPartial: "{added} hinzugefügt, {failed} fehlgeschlagen",
  trackListAddAllFailed: "Die Vorträge konnten nicht zur Playlist hinzugefügt werden.",
  actionOpenLibrary: "Öffnen",
  actionOpenNotes: "Öffnen",
  miniRowOpen: "Vortrag öffnen",

  noteSaved: "Notiz gespeichert",
  noteSaving: "Notiz wird gespeichert…",
  actionNoteError: "Die Notiz konnte nicht gespeichert werden.",

  actionPdfKind: "Vortragstranskript",
  actionPdfShare: "Teilen",
  actionPdfShared: "Gesendet",
  actionPdfError: "Das PDF konnte nicht vorbereitet werden.",
  actionPdfDialog: "Transkript teilen",

  actionDismiss: "Überspringen",
  actionDismissed: "Verworfen",
  actionRetry: "Wiederholen",
  actionDegraded: "Daten der Aktionskarte fehlen.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Nachricht kopieren",
  copyDone: "Kopiert",
  /** Aria-label for the inline message Share button. */
  shareAction: "Nachricht teilen",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Gute Antwort",
    thumbsDown: "Schlechte Antwort",
    thanks: "Danke für dein Feedback",
    failed: "Feedback konnte nicht gesendet werden — versuche es erneut",
    sheet: {
      title: "Was war nicht in Ordnung?",
      hint: "Alle Felder sind optional. Tippe auf „Absenden“, um zu senden.",
      categoryLabel: "Typ",
      categoryPlaceholder: "Wähle eine Option (optional)",
      commentLabel: "Kommentar",
      commentPlaceholder: "Noch etwas? (optional)",
      submit: "Absenden",
    },
    categories: {
      off_topic: "Am Thema vorbei",
      no_results: "Nichts gefunden",
      bad_citations: "Schlechte Zitate",
      wrong_language: "Falsche Sprache",
      factually_wrong: "Sachlich falsch",
      other: "Sonstiges",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Tägliche Erinnerung",
  proactiveSessionTitleSmartLibrary: "Intelligente Bibliothek",
  proactiveSessionTitleNextShloka: "Vortrag zum nächsten Vers",
  proactiveSessionTitleUnfinishedLecture: "Unbeendeter Vortrag",
  proactiveSessionTitleInactivity: "Zurück zu deiner Praxis",
  proactiveSessionTitleWeeklyDigest: "Deine Woche",
  proactiveSessionTitleDailyWisdom: "Tägliche Weisheit",

  proactiveDailyWisdomBody: "Ein Gedanke aus den Vorträgen für heute:",

  proactiveInactivityWelcomeBody:
    "Du warst eine Weile weg. Frische Vorträge warten schon — öffne deine Bibliothek und höre dort weiter, wo du aufgehört hast.",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Du warst beim vorherigen Vers — mach der Reihe nach weiter. Der nächste ist hier: {ref} „{title}“. In deine Bibliothek aufnehmen?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Du hast „{title}“ begonnen, aber nicht zu Ende gehört. Möchtest du dort weitermachen, wo du aufgehört hast?",

  // Weekly digest proactive session — recap of the past week's listening.
  // `{count}` is the number of additional lectures beyond those listed.
  weeklyDigestTitle: "Deine Woche",
  weeklyDigestIntro: "So verlief deine Woche 🙏",
  weeklyDigestTotalTime: "Gesamte Hörzeit",
  weeklyDigestLectures: "Vorträge diese Woche",
  weeklyDigestStreak: "Tage in Folge",
  weeklyDigestCompleted: "Zu Ende gehört",
  weeklyDigestEmpty:
    "Diese Woche hast du nichts gehört — wähle etwas Frisches und finde zurück in den Rhythmus.",
  weeklyDigestMore: "+{count} weitere",

  proactiveSmartLibraryHintBody:
    "Ich möchte dir die Intelligente Bibliothek zeigen — eine Pro-Funktion, die deine Bibliothek voller frischer Vorträge hält, ohne dass du etwas von Hand in die Warteschlange stellen musst.\n\nDu wählst die Kriterien — Lieblingsautoren, Themen, Quellen, Vortragslänge — und die Intelligente Bibliothek zieht passende Vorträge bis zu einer Ziel-Warteschlangendauer (z. B. 2 Stunden, 8 Stunden, 10 Stunden) leise in deine Bibliothek. Wenn etwas zu Ende gehört ist, wird es automatisch archiviert, damit die Warteschlange frisch bleibt.\n\nGut für den Arbeitsweg und für Spaziergänge, bei denen du keine Zeit damit verbringen möchtest, das Nächste auszuwählen.",
  proactiveEnableNotificationsBody:
    "Du hörst seit ein paar Tagen am Stück — ein schöner Rhythmus. Ich möchte dir vorschlagen, eine tägliche Erinnerung einzurichten, damit du ihn nicht verlierst.\n\nDas ist eine sanfte lokale Benachrichtigung zur Zeit deiner Wahl (ich beginne mit 07:00, du kannst sie jederzeit in den Einstellungen ändern). Kein Lärm im Netz — sie lebt auf deinem Gerät und löst nur aus, wenn die Zeit gekommen ist.\n\nNützlich als täglicher Anker: ein kleiner Anstoß, dass der Vortrag wartet, wann immer dein Tag es zulässt.",

  actionEnableReminderTitle: "Tägliche Erinnerung",
  actionEnableReminderBody:
    "Wähle eine Tageszeit und ich erinnere dich daran, zu hören. Du kannst sie später in den Einstellungen ändern oder ausschalten.",
  actionEnableReminderConfirm: "Einschalten",
  actionEnableReminderDone: "Tägliche Erinnerung ist eingerichtet.",
  actionEnableReminderError: "Benachrichtigungen konnten nicht aktiviert werden.",

  actionConfigureSmartLibraryTitle: "Intelligente Bibliothek",
  actionConfigureSmartLibraryBody:
    "Halte frische Vorträge zu deinen Themen offline bereit. Ich kann diese Filter für dich vorausfüllen.",
  actionConfigureSmartLibraryConfirm: "Einrichten",
  actionConfigureSmartLibraryDone: "In den Einstellungen geöffnet.",
  actionConfigureSmartLibraryError: "Die Intelligente Bibliothek konnte nicht geöffnet werden.",
  actionConfigureSmartLibraryChipAuthors: "{n} Autoren",
  actionConfigureSmartLibraryChipTopics: "{n} Themen",
  actionConfigureSmartLibraryChipSources: "{n} Quellen",
  actionConfigureSmartLibraryChipLocations: "{n} Orte",
  actionConfigureSmartLibraryChipLanguages: "{n} Sprachen",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Schalte die Intelligente Bibliothek, das Notiz-Studio und den Rest von Pro frei, um das Beste aus der App herauszuholen.",
  actionUpgradeToProConfirm: "Pro ansehen",
  actionUpgradeToProDone: "Abo-Seite geöffnet.",
  actionUpgradeToProError: "Der Upgrade-Bildschirm konnte nicht geöffnet werden.",

  actionQueueNextTrackTitle: "Zur Bibliothek hinzufügen",
  actionQueueNextTrackConfirm: "Hinzufügen",
  actionQueueNextTrackDone: "Zur Bibliothek hinzugefügt.",
  actionQueueNextTrackError: "Dieser Vortrag konnte nicht hinzugefügt werden.",

  actionAddToLibraryTitle: "Zu meiner Bibliothek hinzufügen",
  actionAddToLibraryConfirm: "Zur Bibliothek hinzufügen",
  actionAddToLibraryDone: "Hinzugefügt — wird verarbeitet.",
  actionAddToLibraryError: "Dieser Vortrag konnte nicht hinzugefügt werden.",
  addByLinkCommand: "Vortrag über diesen Link hinzufügen: {url}",

  citationSaveAsNote: "Als Notiz speichern",
  citationOpenInStudio: "Im Studio öffnen",
  citationAddLectureToPlaylist: "Vortrag zur Playlist hinzufügen",
  recentSessionsLabel: "Letzte Chats",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "gerade eben",
  timeYesterday: "gestern",
  timeUnitMinute: "Min",
  timeUnitHour: "Std",
  timeUnitDay: "T",
  timeUnitWeek: "Wo",
  timeUnitMonth: "Mon",
  timeUnitYear: "J",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Ich denke nach…",
    searching_corpus: "Ich suche in den Aufnahmen…",
    composing_answer: "Ich schreibe die Antwort…",
    preparing_action: "Wird vorbereitet…",
    browsing_catalog: "Ich durchsuche den Katalog…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Ich wähle Fragen aus…",
  },
}
