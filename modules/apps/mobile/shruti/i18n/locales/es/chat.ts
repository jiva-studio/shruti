export default {
  title: "Chat",
  placeholder: "Haz una pregunta",
  send: "Enviar",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Detener",
  sending: "Pensando…",
  emptyStateTitle: "¿En qué puedo ayudarte?",
  emptyState: "Pregunta lo que quieras: lo buscaré en las grabaciones.",
  newSession: "Nuevo chat",
  history: "Historial de chats",
  historyEmpty: "Aún no hay chats anteriores.",
  searchPlaceholder: "Buscar en el historial",
  searchEmpty: "Sin coincidencias",
  untitledSession: "Chat sin título",
  clearHistory: "Borrar historial de chats",
  clearHistoryConfirm: "¿Eliminar todas las sesiones y mensajes de chat? Esto no se puede deshacer.",
  clearedToast: "Historial de chats borrado.",
  citationActionHeader: "Abrir cita",
  citationOpen: "Abrir clase",
  citationListen: "Escuchar fragmento",
  citationLoading: "Cargando…",
  citationOpenFull: "Abrir clase completa",
  citationDetailsTitle: "Detalles de la cita",
  citationNoAudio: "No hay audio disponible para esta cita",
  citationLoadFailed: "No se pudo cargar el fragmento",
  citationAddedToPlaylist: "Añadido a la lista",
  citationAddFailed: "No se pudo añadir a la lista",
  citationMtBadge: "Traducido automáticamente",
  citationViewOriginal: "Mostrar original",
  citationViewTranslated: "Mostrar traducción",
  lectureCardMissing: "La clase no está disponible en el catálogo local.",
  errRate: "Demasiadas solicitudes. Inténtalo de nuevo en un minuto.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Demasiadas solicitudes. Inténtalo de nuevo {when}.",
  errNetwork: "No se pudo conectar con el chat. Comprueba tu conexión.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Sin internet",
    body: "Lo reintentaré cuando vuelvas a estar en línea.",
    cta: "Reintentar (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "No se pudo conectar con el servidor",
    body: "Inténtalo de nuevo en un momento.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "El chat no está disponible temporalmente",
    body: "No pudimos enviar tu mensaje ahora mismo. Inténtalo de nuevo un poco más tarde.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Límite de solicitudes",
  errQuotaUnknownBody: "Has alcanzado el límite diario, inténtalo más tarde.",
  errServiceNotReady: "El servicio de chat se está iniciando. Inténtalo de nuevo en breve.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "El servicio de chat devolvió un error. Inténtalo de nuevo en breve.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Falló la autorización. Reinicia la app para volver a intentarlo.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Esta versión de la app ya no es compatible. Actualízala.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Actualización requerida",
      body: "El chat usa un nuevo protocolo. Actualiza Shruti para continuar.",
      cta: "Abrir tienda",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Interrupción temporal",
      body: "Inténtalo de nuevo en un momento.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "La conexión se cortó antes de que llegara la respuesta.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "No se pudo obtener una respuesta.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "No se pudo componer una respuesta. Prueba con una consulta más concreta.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (cortado — la conexión se interrumpió)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (detenido — demasiadas llamadas a herramientas)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (detenido)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "en {n}s",
  retryInMinutes: "en {n} min",
  retryAtTime: "a las {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "mañana a las {time}",
  retryNow: "ahora",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Has alcanzado el límite diario de mensajes",
  errQuotaAnonBody: "Inicia sesión para conseguir más mensajes de chat al día. Se restablece {when}.",
  errQuotaFreeTitle: "Has alcanzado el límite diario de mensajes",
  errQuotaFreeBody: "Shruti Pro elimina el límite diario de mensajes. Se restablece {when}.",
  errQuotaProTitle: "Has alcanzado el límite diario",
  errQuotaProBody: "Has agotado los mensajes de chat de hoy. Se restablece {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Iniciar sesión",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Límite diario alcanzado — inténtalo más tarde",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Redacción en pausa, el límite diario se restablece {when}",
  composeLimitedAriaLabelNoTime: "Redacción en pausa, límite diario alcanzado",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% usado · se restablece {date} a las {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Resumir clase actual",
  suggestionRecapRecent: "Resumir última clase",
  followupAriaLabel: "Sugerencia de seguimiento: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "¿Qué significa este fragmento?",
    "Explícalo en palabras sencillas",
    "Dame más contexto",
    "¿De qué escritura es esto?",
  ],
  suggestions: [
    "¿Dónde me quedé?", // user_tracks_list(status='in_progress')
    "Lista sobre el Gītā cap. 2", // propose_playlist
    "Clases sobre BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Lo que escuché esta semana", // user_tracks_list(since=now-7d)
    "¿Qué escucho ahora?", // user_recommendations_get
    "Sobre el bhakti", // chunks_search (semantic)
    "¿Qué es el alma?", // chunks_search (semantic)
    "Paseos matutinos en Bombay", // list_tracks(location=Bombay, tag=morning_walk)
    "Conversaciones en Vrindavan", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF de la última clase", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "¿Quién es Krishna?",
    "¿Por qué sufrimos?",
    "¿Qué es el karma?",
    "¿Qué es la reencarnación?",
    "¿Por qué cantar el mantra?",
    "¿Qué es el bhakti?",
    "¿Quién es un guru?",
    "¿Por qué leer el Bhagavad-gītā?",
    "¿Por qué el vegetarianismo?",
    "¿Cuál es el sentido de la vida?",
    "¿Qué pasa después de la muerte?",
    "¿Qué es el dharma?",
    "¿Quién es Śrīla Prabhupāda?",
    "¿Por dónde empiezo la práctica?",
    "¿Cómo desarrollar amor por Dios?",
    "¿Qué es el santo nombre?",
    "¿Cómo meditar en Krishna?",
  ],

  outlineTitle: "Esquema",
  outlineMore: "Mostrar {n} más",
  outlineRecapPrompt: "Resume el segmento {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Añadir todo a la lista",
  trackListAddAllDone: "{n} clases añadidas a la lista",
  trackListAddAllPartial: "{added} añadidas, {failed} fallidas",
  trackListAddAllFailed: "No se pudieron añadir las clases a la lista.",
  actionOpenLibrary: "Abrir",
  actionOpenNotes: "Abrir",
  miniRowOpen: "Abrir clase",

  noteSaved: "Nota guardada",
  noteSaving: "Guardando nota…",

  actionPdfKind: "Transcripción de la clase",
  actionPdfShare: "Compartir",
  actionPdfShared: "Enviado",
  actionPdfError: "No se pudo preparar el PDF.",
  actionPdfDialog: "Compartir transcripción",

  actionDismiss: "Omitir",
  actionDismissed: "Descartado",
  actionRetry: "Reintentar",
  actionDegraded: "Faltan datos de la tarjeta de acción.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Copiar mensaje",
  copyDone: "Copiado",
  /** Aria-label for the inline message Share button. */
  shareAction: "Compartir mensaje",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Buena respuesta",
    thumbsDown: "Mala respuesta",
    thanks: "Gracias por tu opinión",
    failed: "No se pudo enviar tu opinión — inténtalo de nuevo",
    sheet: {
      title: "¿Qué estuvo mal?",
      hint: "Todos los campos son opcionales. Toca Enviar para mandarlo.",
      categoryLabel: "Tipo",
      categoryPlaceholder: "Elige uno (opcional)",
      commentLabel: "Comentario",
      commentPlaceholder: "¿Algo más? (opcional)",
      submit: "Enviar",
    },
    categories: {
      off_topic: "Fuera de tema",
      no_results: "No se encontró nada",
      bad_citations: "Citas incorrectas",
      wrong_language: "Idioma equivocado",
      factually_wrong: "Factualmente incorrecto",
      other: "Otro",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Recordatorio diario",
  proactiveSessionTitleSmartLibrary: "Biblioteca inteligente",
  proactiveSessionTitleNextShloka: "Siguiente verso",
  proactiveSessionTitleUnfinishedLecture: "Clase sin terminar",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Estabas en el verso anterior — sigue en orden. El siguiente está aquí: {ref} «{title}». ¿Lo añades a tu biblioteca?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Empezaste «{title}» pero no la terminaste. ¿Quieres retomarla donde la dejaste?",

  proactiveSmartLibraryHintBody:
    "Me gustaría mostrarte la Biblioteca inteligente, una función Pro que mantiene tu biblioteca llena de clases nuevas sin que tengas que añadir nada a mano.\n\nTú eliges los criterios —autores favoritos, temas, fuentes, duración de la clase— y la Biblioteca inteligente va trayendo clases que coinciden hasta alcanzar una duración objetivo en la cola (por ejemplo, 2 horas, 8 horas, 10 horas). Cuando terminas algo, se archiva automáticamente para que la cola siga fresca.\n\nIdeal para los trayectos y los paseos, cuando no quieres perder tiempo eligiendo qué escuchar a continuación.",
  proactiveEnableNotificationsBody:
    "Llevas varios días escuchando seguidos — buen ritmo. Me gustaría sugerirte configurar un recordatorio diario para que no lo pierdas.\n\nEs una suave notificación local a la hora que elijas (empezaré con las 07:00, puedes cambiarla cuando quieras en Ajustes). Sin ruido en la red — vive en tu dispositivo y solo se activa cuando llega la hora.\n\nÚtil como ancla diaria: un pequeño empujón de que la clase te espera cuando tu día lo permita.",

  actionEnableReminderTitle: "Recordatorio diario",
  actionEnableReminderBody:
    "Elige una hora cada día y te avisaré para que vengas a escuchar. Puedes cambiarlo o desactivarlo después en Ajustes.",
  actionEnableReminderConfirm: "Activar",
  actionEnableReminderDone: "Recordatorio diario activado.",
  actionEnableReminderError: "No se pudieron activar las notificaciones.",

  actionConfigureSmartLibraryTitle: "Biblioteca inteligente",
  actionConfigureSmartLibraryBody:
    "Mantén clases nuevas sobre tus temas en cola y sin conexión. Puedo dejarte estos filtros preparados.",
  actionConfigureSmartLibraryConfirm: "Configurar",
  actionConfigureSmartLibraryDone: "Abierto en Ajustes.",
  actionConfigureSmartLibraryError: "No se pudo abrir la Biblioteca inteligente.",
  actionConfigureSmartLibraryChipAuthors: "{n} autores",
  actionConfigureSmartLibraryChipTopics: "{n} temas",
  actionConfigureSmartLibraryChipSources: "{n} fuentes",
  actionConfigureSmartLibraryChipLocations: "{n} lugares",
  actionConfigureSmartLibraryChipLanguages: "{n} idiomas",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Desbloquea la Biblioteca inteligente, el Estudio de notas y el resto de Pro para aprovechar la app al máximo.",
  actionUpgradeToProConfirm: "Ver Pro",
  actionUpgradeToProDone: "Página de suscripción abierta.",
  actionUpgradeToProError: "No se pudo abrir la pantalla de mejora.",

  actionQueueNextTrackTitle: "Añadir a la biblioteca",
  actionQueueNextTrackConfirm: "Añadir",
  actionQueueNextTrackDone: "Añadido a la biblioteca.",
  actionQueueNextTrackError: "No se pudo añadir esta clase.",

  citationSaveAsNote: "Guardar como nota",
  citationOpenInStudio: "Abrir en el Estudio",
  citationAddLectureToPlaylist: "Añadir clase a la lista",
  recentSessionsLabel: "Chats recientes",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "ahora mismo",
  timeYesterday: "ayer",
  timeUnitMinute: "min",
  timeUnitHour: "h",
  timeUnitDay: "d",
  timeUnitWeek: "sem",
  timeUnitMonth: "mes",
  timeUnitYear: "a",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Pensando…",
    searching_corpus: "Buscando en las grabaciones…",
    composing_answer: "Escribiendo la respuesta…",
    preparing_action: "Preparando…",
    browsing_catalog: "Explorando el catálogo…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Eligiendo preguntas…",
  },
}
