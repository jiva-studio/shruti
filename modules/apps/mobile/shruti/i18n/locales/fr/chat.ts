export default {
  title: "Chat",
  placeholder: "Posez une question",
  send: "Envoyer",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Arrêter",
  sending: "Je réfléchis…",
  emptyStateTitle: "Comment puis-je vous aider ?",
  emptyState: "Demandez-moi ce que vous voulez — je chercherai dans les enregistrements.",
  newSession: "Nouveau chat",
  history: "Historique des chats",
  historyEmpty: "Aucun chat pour l'instant.",
  searchPlaceholder: "Rechercher dans l'historique",
  searchEmpty: "Aucun résultat",
  untitledSession: "Sans titre",
  clearHistory: "Effacer l'historique des chats",
  clearHistoryConfirm: "Supprimer tous les chats et messages ? Cette action est irréversible.",
  clearedToast: "Historique des chats effacé.",
  citationActionHeader: "Ouvrir la citation",
  citationOpen: "Ouvrir la conférence",
  citationListen: "Écouter l'extrait",
  citationLoading: "Chargement…",
  citationOpenFull: "Ouvrir la conférence complète",
  citationDetailsTitle: "Détails de la citation",
  citationNoAudio: "Aucun audio disponible pour cette citation",
  citationLoadFailed: "Impossible de charger l'extrait",
  citationAddedToPlaylist: "Ajouté à la playlist",
  citationAddFailed: "Impossible d'ajouter à la playlist",
  citationMtBadge: "Traduit automatiquement",
  citationViewOriginal: "Afficher l'original",
  citationViewTranslated: "Afficher la traduction",
  lectureCardMissing: "Conférence absente du catalogue local.",
  errRate: "Trop de requêtes. Réessayez dans une minute.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Trop de requêtes. Réessayez {when}.",
  errNetwork: "Impossible de joindre le service de chat. Vérifiez votre connexion.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Pas de connexion",
    body: "Nouvelle tentative dès que vous serez de nouveau en ligne.",
    cta: "Réessayer (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Serveur injoignable",
    body: "Réessayez dans un instant.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Le chat est temporairement indisponible",
    body: "Nous n'avons pas pu envoyer votre message pour l'instant. Veuillez réessayer un peu plus tard.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Limite de requêtes",
  errQuotaUnknownBody: "Limite quotidienne atteinte, réessayez plus tard.",
  errServiceNotReady: "Le service de chat démarre. Réessayez dans un instant.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Le service de chat a renvoyé une erreur. Réessayez dans un instant.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Échec de l'autorisation. Redémarrez l'application pour réessayer.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol:
    "Cette version de l'application n'est plus prise en charge. Veuillez la mettre à jour.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Mise à jour requise",
      body: "Le chat utilise un nouveau protocole. Mettez à jour Shruti pour continuer.",
      cta: "Ouvrir le store",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Panne temporaire",
      body: "Réessayez dans un instant.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "La connexion a été interrompue avant l'arrivée de la réponse.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Impossible d'obtenir une réponse.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Impossible de composer une réponse. Essayez une requête plus précise.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (interrompu — connexion perdue)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (interrompu — trop d'appels d'outils)",
  /** Appended when the server reported an error mid-answer (turn timeout,
   *  agent failure) — the connection itself was fine. */
  errTruncatedError: " (interrompu — la réponse n'a pas pu être terminée)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (arrêté)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "dans {n} s",
  retryInMinutes: "dans {n} min",
  retryAtTime: "à {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "demain à {time}",
  retryNow: "maintenant",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Limite quotidienne de messages atteinte",
  errQuotaAnonBody:
    "Connectez-vous pour obtenir plus de messages par jour. Réinitialisation {when}.",
  errQuotaFreeTitle: "Limite quotidienne de messages atteinte",
  errQuotaFreeBody:
    "Avec Shruti Pro, la limite quotidienne disparaît. Réinitialisation {when}.",
  errQuotaProTitle: "Limite quotidienne atteinte",
  errQuotaProBody: "Vous avez épuisé vos messages du jour. Réinitialisation {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Se connecter",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Limite quotidienne atteinte — réessayez plus tard",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Saisie en pause, la limite quotidienne se réinitialise {when}",
  composeLimitedAriaLabelNoTime: "Saisie en pause, limite quotidienne atteinte",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p} % utilisés · réinitialisation {date} à {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Résumer la conférence en cours",
  suggestionRecapRecent: "Résumer la dernière conférence",
  followupAriaLabel: "Suggestion : {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Que signifie ce fragment ?",
    "Explique en termes simples",
    "Donne-moi plus de contexte",
    "De quelle écriture cela provient-il ?",
  ],
  suggestions: [
    "Où me suis-je arrêté ?", // user_tracks_list(status='in_progress')
    "Une playlist sur la Gītā ch. 2", // propose_playlist
    "Conférences sur BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Ce que j'ai écouté cette semaine", // user_tracks_list(since=now-7d)
    "Quoi écouter ensuite ?", // user_recommendations_get
    "À propos de la bhakti", // chunks_search (semantic)
    "Qu'est-ce que l'âme ?", // chunks_search (semantic)
    "Promenades matinales à Bombay", // list_tracks(location=Bombay, tag=morning_walk)
    "Entretiens à Vrindavan", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF de la dernière conférence", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Qui est Krishna ?",
    "Pourquoi souffrons-nous ?",
    "Qu'est-ce que le karma ?",
    "Qu'est-ce que la réincarnation ?",
    "Pourquoi chanter le mantra ?",
    "Qu'est-ce que la bhakti ?",
    "Qui est un guru ?",
    "Pourquoi lire la Bhagavad-gītā ?",
    "Pourquoi le végétarisme ?",
    "Quel est le sens de la vie ?",
    "Que se passe-t-il après la mort ?",
    "Qu'est-ce que le dharma ?",
    "Qui est Śrīla Prabhupāda ?",
    "Par où commencer la pratique ?",
    "Comment développer l'amour pour Dieu ?",
    "Qu'est-ce que le saint nom ?",
    "Comment méditer sur Krishna ?",
  ],

  outlineTitle: "Sommaire",
  outlineMore: "Afficher {n} de plus",
  outlineRecapPrompt: "Résume le fragment {from}–{to} : {title}",

  trackListAddAllToPlaylist: "Tout ajouter à la playlist",
  trackListAddAllDone: "{n} conférences ajoutées à la playlist",
  trackListAddAllPartial: "{added} ajoutées, {failed} échouées",
  trackListAddAllFailed: "Impossible d'ajouter les conférences à la playlist.",
  actionOpenLibrary: "Ouvrir",
  actionOpenNotes: "Ouvrir",
  miniRowOpen: "Ouvrir la conférence",

  noteSaved: "Note enregistrée",
  noteSaving: "Enregistrement de la note…",
  actionNoteError: "Impossible d'enregistrer la note.",

  actionPdfKind: "Transcription de la conférence",
  actionPdfShare: "Partager",
  actionPdfShared: "Envoyé",
  actionPdfError: "Impossible de préparer le PDF.",
  actionPdfDialog: "Partager la transcription",

  actionDismiss: "Pas besoin",
  actionDismissed: "Action annulée",
  actionRetry: "Réessayer",
  actionDegraded: "Les données de la carte d'action sont manquantes.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Copier le message",
  copyDone: "Copié",
  /** Aria-label for the inline message Share button. */
  shareAction: "Partager le message",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Bonne réponse",
    thumbsDown: "Mauvaise réponse",
    thanks: "Merci pour votre retour",
    failed: "Échec de l'envoi — réessayez",
    sheet: {
      title: "Qu'est-ce qui n'allait pas ?",
      hint: "Tous les champs sont facultatifs. Appuyez sur Envoyer pour transmettre.",
      categoryLabel: "Type",
      categoryPlaceholder: "Choisissez (facultatif)",
      commentLabel: "Commentaire",
      commentPlaceholder: "Autre chose ? (facultatif)",
      submit: "Envoyer",
    },
    categories: {
      off_topic: "Hors sujet",
      no_results: "Rien trouvé",
      bad_citations: "Mauvaises citations",
      wrong_language: "Mauvaise langue",
      factually_wrong: "Factuellement faux",
      other: "Autre",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Rappel quotidien",
  proactiveSessionTitleSmartLibrary: "Bibliothèque intelligente",
  proactiveSessionTitleNextShloka: "Conférence sur le verset suivant",
  proactiveSessionTitleUnfinishedLecture: "Conférence inachevée",
  proactiveSessionTitleInactivity: "Reprenez votre pratique",
  proactiveSessionTitleWeeklyDigest: "Votre semaine",
  proactiveSessionTitleDailyWisdom: "Sagesse du jour",

  proactiveDailyWisdomBody: "Une pensée tirée des conférences pour aujourd'hui :",

  // Welcome body shown when re-engaging the user after a period of
  // inactivity (the `inactivity` proactive rule).
  proactiveInactivityWelcomeBody:
    "Cela fait un moment. De nouvelles conférences vous attendent — ouvrez votre bibliothèque et reprenez là où vous vous êtes arrêté.",

  // Weekly digest of the user's listening activity.
  weeklyDigestTitle: "Votre semaine",
  weeklyDigestIntro: "Voici comment s'est passée ta semaine 🙏",
  weeklyDigestTotalTime: "Temps d'écoute total",
  weeklyDigestLectures: "Conférences cette semaine",
  weeklyDigestStreak: "Jours d'affilée",
  weeklyDigestCompleted: "Terminées",
  weeklyDigestEmpty:
    "Vous n'avez rien écouté cette semaine — choisissez une nouveauté pour reprendre le rythme.",
  weeklyDigestMore: "+{count} de plus",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Vous écoutiez le verset précédent — continuez dans l'ordre. Le suivant est ici : {ref} « {title} ». L'ajouter à votre bibliothèque ?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Vous avez commencé « {title} » mais ne l'avez pas terminée. Voulez-vous reprendre là où vous vous êtes arrêté ?",

  proactiveSmartLibraryHintBody:
    "J'aimerais vous présenter la Bibliothèque intelligente — une fonctionnalité Pro qui garde votre bibliothèque toujours remplie de nouvelles conférences, sans que vous ayez à en ajouter manuellement.\n\nVous choisissez les critères — auteurs préférés, thèmes, sources, durée des conférences — et la Bibliothèque intelligente ajoute discrètement les conférences correspondantes à votre bibliothèque jusqu'à une durée de file cible (par exemple 2 heures, 8 heures, 10 heures). Une fois une conférence terminée, elle est automatiquement archivée pour que la file reste fraîche.\n\nIdéal pour les trajets et les promenades, quand vous ne voulez pas perdre de temps à choisir quoi écouter ensuite.",
  proactiveEnableNotificationsBody:
    "Vous écoutez plusieurs jours d'affilée — beau rythme. J'aimerais vous suggérer de configurer un rappel quotidien pour ne pas le perdre.\n\nC'est une seule notification locale, en douceur, à l'heure que vous choisissez (je commencerai par 07:00, modifiable à tout moment dans les Paramètres). Aucun bruit sur le réseau — elle vit sur votre appareil et ne se déclenche qu'au moment voulu.\n\nUtile comme ancre quotidienne : un petit rappel que la conférence vous attend dès que votre journée le permet.",

  actionEnableReminderTitle: "Rappel quotidien",
  actionEnableReminderBody:
    "Choisissez une heure chaque jour et je vous rappellerai de venir écouter. Vous pourrez le modifier ou le désactiver plus tard dans les Paramètres.",
  actionEnableReminderConfirm: "Activer",
  actionEnableReminderDone: "Le rappel quotidien est activé.",
  actionEnableReminderError: "Impossible d'activer les notifications.",

  actionConfigureSmartLibraryTitle: "Bibliothèque intelligente",
  actionConfigureSmartLibraryBody:
    "Gardez hors ligne de nouvelles conférences sur vos thèmes. Je peux pré-remplir ces filtres pour vous.",
  actionConfigureSmartLibraryConfirm: "Configurer",
  actionConfigureSmartLibraryDone: "Ouvert dans les Paramètres.",
  actionConfigureSmartLibraryError: "Impossible d'ouvrir la Bibliothèque intelligente.",
  actionConfigureSmartLibraryChipAuthors: "{n} auteurs",
  actionConfigureSmartLibraryChipTopics: "{n} thèmes",
  actionConfigureSmartLibraryChipSources: "{n} sources",
  actionConfigureSmartLibraryChipLocations: "{n} lieux",
  actionConfigureSmartLibraryChipLanguages: "{n} langues",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Débloquez la Bibliothèque intelligente, le Studio de notes et le reste de Pro pour profiter pleinement de l'application.",
  actionUpgradeToProConfirm: "Voir Pro",
  actionUpgradeToProDone: "Page d'abonnement ouverte.",
  actionUpgradeToProError: "Impossible d'ouvrir l'écran d'abonnement.",

  actionQueueNextTrackTitle: "Ajouter à la bibliothèque",
  actionQueueNextTrackConfirm: "Ajouter",
  actionQueueNextTrackDone: "Ajouté à la bibliothèque.",
  actionQueueNextTrackError: "Impossible d'ajouter cette conférence.",

  actionAddToLibraryTitle: "Ajouter à ma bibliothèque",
  actionAddToLibraryConfirm: "Ajouter à la bibliothèque",
  actionAddToLibraryDone: "Ajoutée — traitement en cours.",
  actionAddToLibraryError: "Impossible d'ajouter cette conférence.",
  addByLinkCommand: "Ajouter la conférence depuis ce lien : {url}",

  citationSaveAsNote: "Enregistrer comme note",
  citationOpenInStudio: "Ouvrir dans le Studio",
  citationAddLectureToPlaylist: "Ajouter la conférence à la playlist",
  recentSessionsLabel: "Chats récents",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "à l'instant",
  timeYesterday: "hier",
  timeUnitMinute: "min",
  timeUnitHour: "h",
  timeUnitDay: "j",
  timeUnitWeek: "sem",
  timeUnitMonth: "mois",
  timeUnitYear: "an",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Je réfléchis…",
    searching_corpus: "Je cherche dans les enregistrements…",
    composing_answer: "Je rédige la réponse…",
    preparing_action: "Je prépare…",
    browsing_catalog: "Je parcours le catalogue…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Je choisis des questions…",
  },
}
