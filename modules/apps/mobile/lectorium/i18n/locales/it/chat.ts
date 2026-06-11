export default {
  title: "Chat",
  placeholder: "Fai una domanda",
  send: "Invia",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Ferma",
  sending: "Sto pensando…",
  emptyStateTitle: "Come posso aiutarti?",
  emptyState: "Chiedimi qualsiasi cosa — la cerco nelle registrazioni.",
  newSession: "Nuova chat",
  history: "Cronologia chat",
  historyEmpty: "Ancora nessuna chat.",
  searchPlaceholder: "Cerca nella cronologia",
  searchEmpty: "Nessun risultato",
  untitledSession: "Chat senza titolo",
  clearHistory: "Cancella cronologia chat",
  clearHistoryConfirm: "Eliminare tutte le chat e i messaggi? L'azione non può essere annullata.",
  clearedToast: "Cronologia chat cancellata.",
  citationActionHeader: "Apri citazione",
  citationOpen: "Apri lezione",
  citationListen: "Ascolta il frammento",
  citationLoading: "Caricamento…",
  citationOpenFull: "Apri la lezione completa",
  citationDetailsTitle: "Dettagli della citazione",
  citationNoAudio: "Nessun audio disponibile per questa citazione",
  citationLoadFailed: "Impossibile caricare il frammento",
  citationAddedToPlaylist: "Aggiunto alla playlist",
  citationAddFailed: "Impossibile aggiungere alla playlist",
  citationMtBadge: "Tradotto automaticamente",
  citationViewOriginal: "Mostra originale",
  citationViewTranslated: "Mostra traduzione",
  lectureCardMissing: "Lezione non disponibile nel catalogo locale.",
  errRate: "Troppe richieste. Riprova tra un minuto.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Troppe richieste. Riprova {when}.",
  errNetwork: "Impossibile raggiungere il servizio chat. Controlla la connessione.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Nessuna connessione",
    body: "Riproveremo automaticamente appena torni online.",
    cta: "Riprova (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Server non raggiungibile",
    body: "Riprova tra un istante.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "La chat è temporaneamente non disponibile",
    body: "Non siamo riusciti a inviare il tuo messaggio ora. Riprova un po' più tardi.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Limite di richieste",
  errQuotaUnknownBody: "Limite giornaliero raggiunto, riprova più tardi.",
  errServiceNotReady: "Il servizio chat si sta avviando. Riprova tra poco.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Il servizio chat ha restituito un errore. Riprova tra poco.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Autorizzazione non riuscita. Riavvia l'app per riprovare.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Questa versione dell'app non è più supportata. Aggiornala.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Aggiornamento richiesto",
      body: "La chat usa un nuovo protocollo. Aggiorna Lectorium per continuare.",
      cta: "Apri store",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Interruzione temporanea",
      body: "Riprova tra un istante.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "La connessione si è interrotta prima dell'arrivo della risposta.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Impossibile ottenere una risposta.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Non sono riuscito a comporre una risposta. Prova con una domanda più mirata.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (interrotto — connessione caduta)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (interrotto — troppe chiamate agli strumenti)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (fermato)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "tra {n}s",
  retryInMinutes: "tra {n} min",
  retryAtTime: "alle {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "domani alle {time}",
  retryNow: "adesso",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Limite giornaliero di messaggi raggiunto",
  errQuotaAnonBody: "Accedi per avere più messaggi al giorno. Si azzera {when}.",
  errQuotaFreeTitle: "Limite giornaliero di messaggi raggiunto",
  errQuotaFreeBody: "Shruti Pro elimina il limite giornaliero. Si azzera {when}.",
  errQuotaProTitle: "Limite giornaliero raggiunto",
  errQuotaProBody: "Hai esaurito i messaggi di oggi. Si azzera {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Accedi",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Limite raggiunto — riprova più tardi",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Composizione in pausa, il limite giornaliero si azzera {when}",
  composeLimitedAriaLabelNoTime: "Composizione in pausa, limite giornaliero raggiunto",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% usato · si azzera il {date} alle {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Riassumi la lezione attuale",
  suggestionRecapRecent: "Riassumi l'ultima lezione",
  followupAriaLabel: "Domanda suggerita: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Cosa significa questo frammento?",
    "Spiega in parole semplici",
    "Dammi più contesto",
    "Da quale scrittura proviene?",
  ],
  suggestions: [
    "Dove mi sono fermato?", // user_tracks_list(status='in_progress')
    "Playlist sulla Gita cap. 2", // propose_playlist
    "Lezioni su BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Cosa ho ascoltato questa settimana", // user_tracks_list(since=now-7d)
    "Cosa ascoltare dopo?", // user_recommendations_get
    "Parlami della bhakti", // chunks_search (semantic)
    "Cos'è l'anima?", // chunks_search (semantic)
    "Passeggiate mattutine a Bombay", // list_tracks(location=Bombay, tag=morning_walk)
    "Conversazioni a Vrindavana", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF dell'ultima lezione", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Chi è Krishna?",
    "Perché soffriamo?",
    "Cos'è il karma?",
    "Cos'è la reincarnazione?",
    "Perché cantare il mantra?",
    "Cos'è la bhakti?",
    "Chi è un guru?",
    "Perché leggere la Bhagavad-gītā?",
    "Perché il vegetarianismo?",
    "Qual è il senso della vita?",
    "Cosa accade dopo la morte?",
    "Cos'è il dharma?",
    "Chi è Śrīla Prabhupāda?",
    "Da dove inizio la pratica?",
    "Come sviluppare l'amore per Dio?",
    "Cos'è il santo nome?",
    "Come meditare su Krishna?",
  ],

  outlineTitle: "Indice",
  outlineMore: "Mostra altri {n}",
  outlineRecapPrompt: "Riassumi il frammento {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Aggiungi tutte alla playlist",
  trackListAddAllDone: "{n} lezioni aggiunte alla playlist",
  trackListAddAllPartial: "{added} aggiunte, {failed} non riuscite",
  trackListAddAllFailed: "Impossibile aggiungere le lezioni alla playlist.",
  actionOpenLibrary: "Apri",
  actionOpenNotes: "Apri",
  miniRowOpen: "Apri lezione",

  noteSaved: "Nota salvata",
  noteSaving: "Salvataggio nota…",

  actionPdfKind: "Trascrizione della lezione",
  actionPdfShare: "Condividi",
  actionPdfShared: "Inviato",
  actionPdfError: "Impossibile preparare il PDF.",
  actionPdfDialog: "Condividi trascrizione",

  actionDismiss: "Salta",
  actionDismissed: "Ignorato",
  actionRetry: "Riprova",
  actionDegraded: "Dati della scheda azione mancanti.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Copia messaggio",
  copyDone: "Copiato",
  /** Aria-label for the inline message Share button. */
  shareAction: "Condividi messaggio",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Buona risposta",
    thumbsDown: "Risposta sbagliata",
    thanks: "Grazie per il feedback",
    failed: "Impossibile inviare il feedback — riprova",
    sheet: {
      title: "Cosa non andava?",
      hint: "Tutti i campi sono facoltativi. Tocca Invia per inviare.",
      categoryLabel: "Tipo",
      categoryPlaceholder: "Scegline uno (facoltativo)",
      commentLabel: "Commento",
      commentPlaceholder: "Qualcos'altro? (facoltativo)",
      submit: "Invia",
    },
    categories: {
      off_topic: "Fuori tema",
      no_results: "Nessun risultato",
      bad_citations: "Citazioni errate",
      wrong_language: "Lingua sbagliata",
      factually_wrong: "Fattualmente errato",
      other: "Altro",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Promemoria quotidiano",
  proactiveSessionTitleSmartLibrary: "Biblioteca intelligente",
  proactiveSessionTitleNextShloka: "Verso successivo",
  proactiveSessionTitleUnfinishedLecture: "Lezione non terminata",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Eri al verso precedente — continua in ordine. Il prossimo è qui: {ref} “{title}”. Vuoi aggiungerlo alla tua biblioteca?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Hai iniziato “{title}” ma non l'hai finita. Vuoi riprendere da dove eri rimasto?",

  proactiveSmartLibraryHintBody:
    "Vorrei mostrarti la Biblioteca intelligente — una funzione Pro che tiene la tua biblioteca sempre piena di nuove lezioni senza che tu debba aggiungerne nessuna a mano.\n\nScegli tu i criteri — autori preferiti, temi, fonti, durata delle lezioni — e la Biblioteca intelligente porta in modo discreto le lezioni corrispondenti nella tua biblioteca fino a una durata obiettivo della coda (ad esempio 2 ore, 8 ore, 10 ore). Quando una lezione è terminata viene archiviata automaticamente, così la coda resta sempre fresca.\n\nUtile per gli spostamenti e le passeggiate, quando non vuoi perdere tempo a scegliere cosa ascoltare dopo.",
  proactiveEnableNotificationsBody:
    "Stai ascoltando da alcuni giorni di fila — bel ritmo. Vorrei suggerirti di impostare un promemoria quotidiano per non perderlo.\n\nÈ una sola notifica locale e delicata all'ora che scegli (imposto le 07:00, puoi cambiarla quando vuoi nelle Impostazioni). Nessun rumore in rete — vive sul tuo dispositivo e scatta solo quando arriva il momento.\n\nUtile come ancoraggio quotidiano: un piccolo richiamo che la lezione ti aspetta quando la giornata te lo consente.",

  actionEnableReminderTitle: "Promemoria quotidiano",
  actionEnableReminderBody:
    "Scegli un'ora ogni giorno e ti ricorderò di venire ad ascoltare. Puoi cambiarla o disattivarla più tardi nelle Impostazioni.",
  actionEnableReminderConfirm: "Attiva",
  actionEnableReminderDone: "Promemoria quotidiano impostato.",
  actionEnableReminderError: "Impossibile attivare le notifiche.",

  actionConfigureSmartLibraryTitle: "Biblioteca intelligente",
  actionConfigureSmartLibraryBody:
    "Tieni nuove lezioni sui tuoi temi pronte offline. Posso pre-compilare questi filtri per te.",
  actionConfigureSmartLibraryConfirm: "Configura",
  actionConfigureSmartLibraryDone: "Aperto nelle Impostazioni.",
  actionConfigureSmartLibraryError: "Impossibile aprire la Biblioteca intelligente.",
  actionConfigureSmartLibraryChipAuthors: "{n} autori",
  actionConfigureSmartLibraryChipTopics: "{n} temi",
  actionConfigureSmartLibraryChipSources: "{n} fonti",
  actionConfigureSmartLibraryChipLocations: "{n} luoghi",
  actionConfigureSmartLibraryChipLanguages: "{n} lingue",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Sblocca la Biblioteca intelligente, lo Studio delle note e il resto di Pro per sfruttare al meglio l'app.",
  actionUpgradeToProConfirm: "Scopri Pro",
  actionUpgradeToProDone: "Pagina dell'abbonamento aperta.",
  actionUpgradeToProError: "Impossibile aprire la schermata di upgrade.",

  actionQueueNextTrackTitle: "Aggiungi alla biblioteca",
  actionQueueNextTrackConfirm: "Aggiungi",
  actionQueueNextTrackDone: "Aggiunto alla biblioteca.",
  actionQueueNextTrackError: "Impossibile aggiungere questa lezione.",

  citationSaveAsNote: "Salva come nota",
  citationOpenInStudio: "Apri nello Studio",
  citationAddLectureToPlaylist: "Aggiungi lezione alla playlist",
  recentSessionsLabel: "Chat recenti",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "proprio ora",
  timeYesterday: "ieri",
  timeUnitMinute: "m",
  timeUnitHour: "h",
  timeUnitDay: "g",
  timeUnitWeek: "sett",
  timeUnitMonth: "mes",
  timeUnitYear: "a",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Sto pensando…",
    searching_corpus: "Cerco nelle registrazioni…",
    composing_answer: "Scrivo la risposta…",
    preparing_action: "Preparo…",
    browsing_catalog: "Sfoglio il catalogo…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Scelgo le domande…",
  },
}
