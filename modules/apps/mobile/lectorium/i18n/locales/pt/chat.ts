export default {
  title: "Chat",
  placeholder: "Faça uma pergunta",
  send: "Enviar",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Parar",
  sending: "Pensando…",
  emptyStateTitle: "Como posso ajudar?",
  emptyState: "Pergunte o que quiser — vou procurar nas gravações.",
  newSession: "Novo chat",
  history: "Histórico de chats",
  historyEmpty: "Nenhum chat ainda.",
  searchPlaceholder: "Buscar no histórico",
  searchEmpty: "Nenhum resultado",
  untitledSession: "Sem título",
  clearHistory: "Limpar histórico de chats",
  clearHistoryConfirm: "Excluir todos os chats e mensagens? Essa ação não pode ser desfeita.",
  clearedToast: "Histórico de chats limpo.",
  citationActionHeader: "Abrir citação",
  citationOpen: "Abrir aula",
  citationListen: "Ouvir trecho",
  citationLoading: "Carregando…",
  citationOpenFull: "Abrir aula completa",
  citationDetailsTitle: "Detalhes da citação",
  citationNoAudio: "Não há áudio disponível para esta citação",
  citationLoadFailed: "Não foi possível carregar o trecho",
  citationAddedToPlaylist: "Adicionado à playlist",
  citationAddFailed: "Não foi possível adicionar à playlist",
  citationMtBadge: "Traduzido automaticamente",
  citationViewOriginal: "Mostrar original",
  citationViewTranslated: "Mostrar tradução",
  lectureCardMissing: "Aula indisponível no catálogo local.",
  errRate: "Muitas solicitações. Tente novamente em um minuto.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Muitas solicitações. Tente novamente {when}.",
  errNetwork: "Não foi possível conectar ao chat. Verifique sua conexão.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Sem internet",
    body: "Vamos tentar de novo assim que você voltar a ficar online.",
    cta: "Tentar de novo (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Servidor indisponível",
    body: "Tente novamente em instantes.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "O chat está temporariamente indisponível",
    body: "Não conseguimos enviar sua mensagem agora. Tente novamente um pouco mais tarde.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Limite de solicitações",
  errQuotaUnknownBody: "Limite diário atingido, tente mais tarde.",
  errServiceNotReady: "O serviço de chat está iniciando. Tente novamente em instantes.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "O serviço de chat retornou um erro. Tente novamente em instantes.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Falha na autorização. Reinicie o app para tentar de novo.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Esta versão do app não é mais compatível. Atualize, por favor.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Atualização necessária",
      body: "O chat usa um novo protocolo. Atualize o Lectorium para continuar.",
      cta: "Abrir loja",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Indisponibilidade temporária",
      body: "Tente novamente em instantes.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "A conexão caiu antes da resposta chegar.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Não foi possível obter uma resposta.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Não foi possível montar uma resposta. Tente uma pergunta mais específica.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (interrompido — a conexão caiu)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (interrompido — chamadas de ferramenta em excesso)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (parado)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "em {n}s",
  retryInMinutes: "em {n} min",
  retryAtTime: "às {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "amanhã às {time}",
  retryNow: "agora",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Limite diário de mensagens atingido",
  errQuotaAnonBody: "Entre na conta para receber mais mensagens por dia. Renova {when}.",
  errQuotaFreeTitle: "Limite diário de mensagens atingido",
  errQuotaFreeBody: "O Shruti Pro remove o limite diário de mensagens. Renova {when}.",
  errQuotaProTitle: "Limite diário atingido",
  errQuotaProBody: "Você usou as mensagens de chat de hoje. Renova {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Entrar",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Limite diário atingido — tente mais tarde",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Entrada pausada, o limite diário renova {when}",
  composeLimitedAriaLabelNoTime: "Entrada pausada, limite diário atingido",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% usado · renova {date} às {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Resumir aula atual",
  suggestionRecapRecent: "Resumir última aula",
  followupAriaLabel: "Sugestão de continuação: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "O que significa este trecho?",
    "Explique em termos simples",
    "Dê mais contexto",
    "De qual escritura é isto?",
  ],
  suggestions: [
    "Onde eu parei?", // user_tracks_list(status='in_progress')
    "Playlist sobre o Gītā cap. 2", // propose_playlist
    "Aulas sobre BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "O que ouvi esta semana", // user_tracks_list(since=now-7d)
    "O que ouvir agora?", // user_recommendations_get
    "Sobre bhakti", // chunks_search (semantic)
    "O que é a alma?", // chunks_search (semantic)
    "Caminhadas matinais em Bombay", // list_tracks(location=Bombay, tag=morning_walk)
    "Conversas em Vrindavan", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF da última aula", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Quem é Krishna?",
    "Por que sofremos?",
    "O que é karma?",
    "O que é reencarnação?",
    "Por que cantar o mantra?",
    "O que é bhakti?",
    "Quem é um guru?",
    "Por que ler o Bhagavad-gītā?",
    "Por que o vegetarianismo?",
    "Qual é o sentido da vida?",
    "O que acontece após a morte?",
    "O que é dharma?",
    "Quem é Śrīla Prabhupāda?",
    "Por onde começo a prática?",
    "Como desenvolver amor por Deus?",
    "O que é o santo nome?",
    "Como meditar em Krishna?",
  ],

  outlineTitle: "Roteiro",
  outlineMore: "Mostrar mais {n}",
  outlineRecapPrompt: "Resuma o trecho {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Adicionar tudo à playlist",
  trackListAddAllDone: "{n} aulas adicionadas à playlist",
  trackListAddAllPartial: "{added} adicionadas, {failed} falharam",
  trackListAddAllFailed: "Não foi possível adicionar as aulas à playlist.",
  actionOpenLibrary: "Abrir",
  actionOpenNotes: "Abrir",
  miniRowOpen: "Abrir aula",

  noteSaved: "Nota salva",
  noteSaving: "Salvando nota…",
  actionNoteError: "Não foi possível salvar a nota.",

  actionPdfKind: "Transcrição da aula",
  actionPdfShare: "Compartilhar",
  actionPdfShared: "Enviado",
  actionPdfError: "Não foi possível preparar o PDF.",
  actionPdfDialog: "Compartilhar transcrição",

  actionDismiss: "Pular",
  actionDismissed: "Dispensado",
  actionRetry: "Tentar de novo",
  actionDegraded: "Faltam dados do cartão de ação.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Copiar mensagem",
  copyDone: "Copiado",
  /** Aria-label for the inline message Share button. */
  shareAction: "Compartilhar mensagem",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Boa resposta",
    thumbsDown: "Resposta ruim",
    thanks: "Obrigado pelo feedback",
    failed: "Não foi possível enviar o feedback — tente de novo",
    sheet: {
      title: "O que houve de errado?",
      hint: "Todos os campos são opcionais. Toque em Enviar para enviar.",
      categoryLabel: "Tipo",
      categoryPlaceholder: "Escolha um (opcional)",
      commentLabel: "Comentário",
      commentPlaceholder: "Mais alguma coisa? (opcional)",
      submit: "Enviar",
    },
    categories: {
      off_topic: "Fora do tema",
      no_results: "Nada encontrado",
      bad_citations: "Citações ruins",
      wrong_language: "Idioma errado",
      factually_wrong: "Factualmente incorreto",
      other: "Outro",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Lembrete diário",
  proactiveSessionTitleSmartLibrary: "Biblioteca Inteligente",
  proactiveSessionTitleNextShloka: "Aula sobre o próximo verso",
  proactiveSessionTitleUnfinishedLecture: "Aula não concluída",
  proactiveSessionTitleInactivity: "Volte para sua prática",
  proactiveSessionTitleWeeklyDigest: "Sua semana",
  proactiveSessionTitleDailyWisdom: "Sabedoria diária",

  proactiveDailyWisdomBody: "Um pensamento das aulas para hoje:",

  proactiveInactivityWelcomeBody:
    "Faz um tempo. Aulas novas estão esperando — abra sua biblioteca e continue de onde parou.",

  // Weekly digest summary card.
  weeklyDigestTitle: "Sua semana",
  weeklyDigestIntro: "Veja como foi a sua semana 🙏",
  weeklyDigestTotalTime: "Tempo total de escuta",
  weeklyDigestLectures: "Aulas nesta semana",
  weeklyDigestStreak: "Dias seguidos",
  weeklyDigestCompleted: "Concluídas",
  weeklyDigestEmpty: "Você não ouviu nada esta semana — escolha algo novo para voltar ao ritmo.",
  weeklyDigestMore: "+{count} mais",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Você estava no verso anterior — continue na ordem. O próximo está aqui: {ref} “{title}”. Quer adicioná-lo à sua biblioteca?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Você começou “{title}” mas não terminou. Quer continuar de onde parou?",

  proactiveSmartLibraryHintBody:
    "Quero te mostrar a Biblioteca Inteligente — um recurso Pro que mantém sua biblioteca sempre cheia de aulas novas, sem você precisar enfileirar nada à mão.\n\nVocê escolhe os critérios — autores favoritos, temas, fontes, duração das aulas — e a Biblioteca Inteligente puxa silenciosamente aulas correspondentes para sua biblioteca até uma duração-alvo da fila (por exemplo, 2 horas, 8 horas, 10 horas). Quando algo é concluído, vai automaticamente para o arquivo, então a fila permanece sempre nova.\n\nÓtimo para deslocamentos e caminhadas, quando você não quer perder tempo escolhendo o que ouvir em seguida.",
  proactiveEnableNotificationsBody:
    "Você está ouvindo há alguns dias seguidos — bom ritmo. Quero sugerir configurar um lembrete diário para você não perder esse ritmo.\n\nÉ uma notificação local suave no horário que você escolher (vou começar com 07:00, e você pode mudar quando quiser nos Ajustes). Sem barulho na rede — ela fica no seu aparelho e só dispara quando chega a hora.\n\nÚtil como uma âncora diária: um pequeno empurrão de que a aula está esperando, quando o seu dia permitir.",

  actionEnableReminderTitle: "Lembrete diário",
  actionEnableReminderBody:
    "Escolha um horário a cada dia e eu te lembro de vir ouvir. Você pode mudar ou desligar depois nos Ajustes.",
  actionEnableReminderConfirm: "Ativar",
  actionEnableReminderDone: "Lembrete diário configurado.",
  actionEnableReminderError: "Não foi possível ativar as notificações.",

  actionConfigureSmartLibraryTitle: "Biblioteca Inteligente",
  actionConfigureSmartLibraryBody:
    "Mantenha aulas novas sobre seus temas enfileiradas offline. Posso preencher esses filtros para você.",
  actionConfigureSmartLibraryConfirm: "Configurar",
  actionConfigureSmartLibraryDone: "Aberto nos Ajustes.",
  actionConfigureSmartLibraryError: "Não foi possível abrir a Biblioteca Inteligente.",
  actionConfigureSmartLibraryChipAuthors: "{n} autores",
  actionConfigureSmartLibraryChipTopics: "{n} temas",
  actionConfigureSmartLibraryChipSources: "{n} fontes",
  actionConfigureSmartLibraryChipLocations: "{n} locais",
  actionConfigureSmartLibraryChipLanguages: "{n} idiomas",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Desbloqueie a Biblioteca Inteligente, o Estúdio de Notas e o resto do Pro para aproveitar o máximo do app.",
  actionUpgradeToProConfirm: "Ver o Pro",
  actionUpgradeToProDone: "Tela de assinatura aberta.",
  actionUpgradeToProError: "Não foi possível abrir a tela de upgrade.",

  actionQueueNextTrackTitle: "Adicionar à biblioteca",
  actionQueueNextTrackConfirm: "Adicionar",
  actionQueueNextTrackDone: "Adicionado à biblioteca.",
  actionQueueNextTrackError: "Não foi possível adicionar esta aula.",

  actionAddToLibraryTitle: "Adicionar à minha biblioteca",
  actionAddToLibraryConfirm: "Adicionar à biblioteca",
  actionAddToLibraryDone: "Adicionada — estamos processando.",
  actionAddToLibraryError: "Não foi possível adicionar esta aula.",
  addByLinkCommand: "Adicionar aula por este link: {url}",

  citationSaveAsNote: "Salvar como nota",
  citationOpenInStudio: "Abrir no Estúdio",
  citationAddLectureToPlaylist: "Adicionar aula à playlist",
  recentSessionsLabel: "Chats recentes",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "agora mesmo",
  timeYesterday: "ontem",
  timeUnitMinute: "min",
  timeUnitHour: "h",
  timeUnitDay: "d",
  timeUnitWeek: "sem",
  timeUnitMonth: "mês",
  timeUnitYear: "a",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Pensando…",
    searching_corpus: "Buscando nas gravações…",
    composing_answer: "Escrevendo a resposta…",
    preparing_action: "Preparando…",
    browsing_catalog: "Navegando pelo catálogo…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Escolhendo perguntas…",
  },
}
