export default {
  title: "Чат",
  placeholder: "Задайте вопрос",
  send: "Отправить",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Остановить",
  sending: "Думаю…",
  emptyStateTitle: "Чем помочь?",
  emptyState: "Спросите что-нибудь — поищу в записях.",
  newSession: "Новый чат",
  history: "История чатов",
  historyEmpty: "Пока нет ни одного чата.",
  searchPlaceholder: "Поиск по истории",
  searchEmpty: "Ничего не найдено",
  untitledSession: "Без названия",
  clearHistory: "Очистить историю чатов",
  clearHistoryConfirm: "Удалить все чаты и сообщения? Это действие нельзя отменить.",
  clearedToast: "История чатов очищена.",
  citationActionHeader: "Открыть цитату",
  citationOpen: "Открыть лекцию",
  citationListen: "Прослушать фрагмент",
  citationLoading: "Загружаю…",
  citationOpenFull: "Открыть полную лекцию",
  citationDetailsTitle: "Детали цитаты",
  citationNoAudio: "Аудио недоступно для этой цитаты",
  citationLoadFailed: "Не удалось загрузить отрезок",
  citationAddedToPlaylist: "Добавлено в плейлист",
  citationAddFailed: "Не удалось добавить в плейлист",
  citationMtBadge: "Переведено автоматически",
  citationViewOriginal: "Покажи оригинал",
  citationViewTranslated: "Покажи перевод",
  lectureCardMissing: "Лекция отсутствует в локальном каталоге.",
  errRate: "Слишком много запросов. Повторите через минуту.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12 s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Слишком много запросов. Повторите {when}.",
  errNetwork: "Не удалось связаться с чатом. Проверьте подключение.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back. */
  errOffline: {
    title: "Нет подключения",
    body: "Повторим автоматически, как только сеть появится.",
    cta: "Повторить (авто)",
  },
  /** Server-side 5xx failure. Kept separate from `errServiceNotReady` so
   *  the warming-up wording can change without affecting plain 5xx UX. */
  errServer: {
    title: "Сервер недоступен",
    body: "Попробуйте через минуту.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Чат временно недоступен",
    body: "Не удалось отправить сообщение. Попробуйте чуть позже.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo, a tier
   *  added server-side before the mobile app knows it). Keeps the user out
   *  of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Лимит запросов",
  errQuotaUnknownBody: "Дневной лимит исчерпан, попробуйте позже.",
  errServiceNotReady: "Сервис чата запускается. Попробуйте позже.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Сервис чата ответил ошибкой. Попробуйте чуть позже.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Не удалось авторизоваться. Перезапустите приложение.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Эта версия приложения больше не поддерживается. Обновите.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Обновите приложение",
      body: "Чат работает по новому протоколу. Обновите Shruti, чтобы продолжить.",
      cta: "В магазин",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Сервис временно недоступен",
      body: "Попробуйте через минуту.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "Связь оборвалась раньше, чем пришёл ответ.",
  /** Catch-all for `no_body`, `empty`, or any unrecognised code. */
  errUnknown: "Не удалось получить ответ.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. The
   *  network was fine — the model kept looping over tools — so the copy
   *  suggests rephrasing rather than blaming the connection. */
  errMaxTurns: "Не удалось собрать ответ. Попробуйте конкретнее или короче.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (прервано — связь оборвалась)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (прервано — слишком много вызовов инструментов)",
  /** Appended when the server reported an error mid-answer (turn timeout,
   *  agent failure) — the connection itself was fine. */
  errTruncatedError: " (прервано — ответ не удалось завершить)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (остановлено)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "через {n} с",
  retryInMinutes: "через {n} мин",
  retryAtTime: "в {time}",
  /** Used when the reset clock lands on the user's local next day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today. The
   *  day word makes that explicit. */
  retryAtTimeTomorrow: "завтра в {time}",
  retryNow: "сейчас",

  // ── Tier-aware quota copy ─────────────────────────────────────────────
  // Copy omits the per-tier message count — the server config tunes those
  // numbers without a client change. "{when}" shows the actual reset time.
  errQuotaAnonTitle: "Дневной лимит исчерпан",
  errQuotaAnonBody: "Войдите, чтобы получать больше сообщений в день. Обновится {when}.",
  errQuotaFreeTitle: "Дневной лимит исчерпан",
  errQuotaFreeBody: "С подпиской «Shruti Pro» дневной лимит больше. Обновится {when}.",
  errQuotaProTitle: "Дневной лимит исчерпан",
  errQuotaProBody: "Сегодня сообщения в чате закончились. Обновится {when}.",
  signInForMoreCta: "Войти",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown ─────────────────────────────────────────────────
  // The input placeholder is always the static prompt and carries no limit
  // copy. `composeLimitedPlaceholderNoTime` is the usage chip's fallback
  // when the composer is locked but no usage snapshot is available.
  composeLimitedPlaceholderNoTime: "Лимит исчерпан — попробуйте позже",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Ввод приостановлен, дневной лимит обновится {when}",
  composeLimitedAriaLabelNoTime: "Ввод приостановлен, дневной лимит исчерпан",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers — the bucket size differs by tier but the "how full am I"
   *  framing reads the same. Tap on Free/anon opens the paywall directly;
   *  Pro renders the chip as a static info badge. */
  usage: {
    chip: "использовано {p}% · сброс {date}, {time}",
  },

  // Suggestion chips — each chip showcases one agent feature, not a topic.
  // Keep them 2-4 words so they fit one line.
  // The "recap" chip swaps between current / recent / generic to make
  // clear *which* lecture the agent will summarise.
  suggestionRecapCurrent: "Перескажи текущую лекцию",
  suggestionRecapRecent: "Перескажи последнюю лекцию",
  followupAriaLabel: "Подсказка: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // unavailable, etc). Keeps the affordance visible so the user can still
  // seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Что значит этот фрагмент?",
    "Объясни простыми словами",
    "Дай больше контекста",
    "Из какого писания это?",
  ],
  suggestions: [
    "Где остановился?", // user_tracks_list(status='in_progress')
    "Собери плейлист по Гите 2", // propose_playlist
    "Лекции по Гите 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Что слушал на неделе?", // user_tracks_list(since=now-7d)
    "Что послушать ещё?", // user_recommendations_get
    "Расскажи про бхакти", // chunks_search (semantic)
    "Что такое душа?", // chunks_search (semantic)
    "Утренние прогулки в Бомбее", // list_tracks(location=Bombay, tag=morning_walk)
    "Беседы во Вриндаване", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF последней лекции", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Кто такой Кришна?",
    "Почему мы страдаем?",
    "Что такое карма?",
    "Что такое реинкарнация?",
    "Зачем повторять мантру?",
    "Что такое бхакти?",
    "Кто такой гуру?",
    "Зачем читать Бхагавад-гиту?",
    "Почему вегетарианство?",
    "В чём смысл жизни?",
    "Что происходит после смерти?",
    "Что такое дхарма?",
    "Кто такой Шрила Прабхупада?",
    "С чего начать практику?",
    "Как развить любовь к Богу?",
    "Что такое святое имя?",
    "Как медитировать на Кришну?",
  ],

  // Outline card
  outlineTitle: "Оглавление",
  outlineMore: "Показать ещё {n}",
  /** Text injected when the user taps an outline chapter — the agent
   *  uses `user_context.focus` to find the actual range, so wording stays
   *  short and natural. */
  outlineRecapPrompt: "Перескажи фрагмент {from}–{to}: {title}",

  // Track list — multi-card "add all to playlist" button
  trackListAddAllToPlaylist: "Добавить все в плейлист",
  trackListAddAllDone: "{n} лекций добавлено в плейлист",
  trackListAddAllPartial: "{added} добавлено, {failed} не удалось",
  trackListAddAllFailed: "Не удалось добавить лекции в плейлист.",
  actionOpenLibrary: "Открыть",
  actionOpenNotes: "Открыть",
  miniRowOpen: "Открыть лекцию",

  noteSaved: "Заметка сохранена",
  noteSaving: "Сохраняю заметку…",
  actionNoteError: "Не удалось сохранить заметку.",

  // Action cards — share PDF
  actionPdfKind: "Транскрипт лекции",
  actionPdfShare: "Поделиться",
  actionPdfShared: "Отправлено",
  actionPdfError: "Не удалось подготовить PDF.",
  actionPdfDialog: "Поделиться транскриптом",

  // Action cards — common
  actionDismiss: "Не нужно",
  actionDismissed: "Действие отменено",
  actionRetry: "Повторить",
  actionDegraded: "Карточка действия повреждена.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Скопировать сообщение",
  copyDone: "Скопировано",
  /** Aria-label for the inline message Share button. */
  shareAction: "Поделиться сообщением",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Хороший ответ",
    thumbsDown: "Плохой ответ",
    thanks: "Спасибо за отзыв",
    failed: "Не удалось отправить — попробуйте ещё раз",
    sheet: {
      title: "Что было не так?",
      hint: "Все поля необязательные. Нажмите «Отправить», когда готово.",
      categoryLabel: "Тип",
      categoryPlaceholder: "Выберите (необязательно)",
      commentLabel: "Комментарий",
      commentPlaceholder: "Что-нибудь ещё? (необязательно)",
      submit: "Отправить",
    },
    categories: {
      off_topic: "Не по теме",
      no_results: "Ничего не нашлось",
      bad_citations: "Плохие цитаты",
      wrong_language: "Неверный язык",
      factually_wrong: "Фактически неверно",
      other: "Другое",
    },
  },

  // Titles of autonomous tutorial sessions the scheduler creates the first
  // time a rule fires for the user.
  proactiveSessionTitleEnableReminder: "Ежедневное напоминание",
  proactiveSessionTitleSmartLibrary: "Умная библиотека",
  proactiveSessionTitleNextShloka: "Лекция по следующему стиху",
  proactiveSessionTitleUnfinishedLecture: "Незаконченная лекция",
  proactiveSessionTitleInactivity: "Вернись к практике",
  proactiveSessionTitleWeeklyDigest: "Итоги недели",
  proactiveSessionTitleDailyWisdom: "Ежедневная мудрость",

  // Pre-baked intro for the `daily_wisdom` rule; the playable excerpt cite
  // marker follows on its own line.
  proactiveDailyWisdomBody: "Мысль из лекций на сегодня:",

  // Static body for the `inactivity` re-engagement session. The escalating
  // copy lives on the notifications; the chat session itself carries one
  // warm welcome that's ready the moment the row is created (no LLM).
  proactiveInactivityWelcomeBody:
    "Давно тебя не было. Свежие лекции уже ждут — загляни в библиотеку и продолжи слушать.",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the canonical
  // verse label (e.g. "2.14"); `{title}` is the catalog title in the
  // user's locale. The follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Ты недавно слушал лекцию по предыдущему стиху — продолжай по порядку. Следующий уже есть: {ref} «{title}». Добавить в библиотеку?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Ты начал слушать «{title}», но не закончил. Продолжить с того места, где остановился?",

  proactiveSmartLibraryHintBody:
    "Хочу показать тебе умную библиотеку — это Pro-функция, которая держит твою библиотеку всегда наполненной свежими лекциями, без необходимости вручную их добавлять.\n\nТы выбираешь критерии — любимые авторы, темы, источники, длительность — и умная библиотека сама подтягивает подходящие лекции до целевого объёма очереди (например, 2 часа, 8 часов, 10 часов). Когда лекция дослушана — она автоматически уходит в архив, очередь остаётся свежей.\n\nХорошо для дороги и прогулок, когда не хочется тратить время на выбор того что слушать дальше.",
  proactiveEnableNotificationsBody:
    "Ты слушаешь несколько дней подряд — хороший ритм. Предлагаю настроить ежедневное напоминание, чтобы не сбить его.\n\nЭто одно мягкое локальное уведомление в выбранное тобой время (поставлю 07:00 по умолчанию, можно изменить в настройках). Сеть не задействована — уведомление живёт на устройстве и срабатывает только когда наступает время.\n\nПолезно как ежедневный якорь — короткое напоминание, что лекция ждёт, когда у тебя будет время.",

  // Weekly digest card (`weekly_digest` rule). Deterministic — no LLM. All
  // labels static; lecture titles come localised from the catalog.
  weeklyDigestTitle: "Итоги недели",
  weeklyDigestIntro: "Вот как прошла твоя неделя 🙏",
  weeklyDigestTotalTime: "Всего прослушано",
  weeklyDigestLectures: "Лекции за неделю",
  weeklyDigestStreak: "Дней подряд",
  weeklyDigestCompleted: "Дослушано",
  weeklyDigestEmpty:
    "На этой неделе ты ничего не слушал — выбери что-нибудь новое и вернись в ритм.",
  weeklyDigestMore: "ещё {count}",

  actionEnableReminderTitle: "Ежедневное напоминание",
  actionEnableReminderBody:
    "Выбери время — буду присылать напоминание послушать лекцию. Можно поменять или выключить в настройках.",
  actionEnableReminderConfirm: "Включить",
  actionEnableReminderDone: "Напоминание включено.",
  actionEnableReminderError: "Не удалось включить уведомления.",

  actionConfigureSmartLibraryTitle: "Умная библиотека",
  actionConfigureSmartLibraryBody:
    "Держи свежие лекции по своим темам в офлайне. Я могу заранее настроить фильтры под тебя.",
  actionConfigureSmartLibraryConfirm: "Настроить",
  actionConfigureSmartLibraryDone: "Открыто в настройках.",
  actionConfigureSmartLibraryError: "Не удалось открыть умную библиотеку.",
  actionConfigureSmartLibraryChipAuthors: "{n} авторов",
  actionConfigureSmartLibraryChipTopics: "{n} тем",
  actionConfigureSmartLibraryChipSources: "{n} источников",
  actionConfigureSmartLibraryChipLocations: "{n} мест",
  actionConfigureSmartLibraryChipLanguages: "{n} языков",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody: "Открой умную библиотеку, Студию заметок и остальные возможности Pro.",
  actionUpgradeToProConfirm: "Посмотреть Pro",
  actionUpgradeToProDone: "Окно подписки открыто.",
  actionUpgradeToProError: "Не удалось открыть подписку.",

  actionQueueNextTrackTitle: "Добавить в библиотеку",
  actionQueueNextTrackConfirm: "Добавить",
  actionQueueNextTrackDone: "Добавлено в библиотеку.",
  actionQueueNextTrackError: "Не удалось добавить лекцию.",

  // Personal library: candidate card for an external lecture the chat
  // found online — confirming triggers ingest into "My library".
  actionAddToLibraryTitle: "Добавить в мою библиотеку",
  actionAddToLibraryConfirm: "Добавить в библиотеку",
  actionAddToLibraryDone: "Добавлено — идёт обработка.",
  actionAddToLibraryError: "Не удалось добавить лекцию.",
  // The chat turn sent when the user taps "Add" on a candidate — a readable
  // command (not a bare URL) that routes back into add-to-library.
  addByLinkCommand: "Добавить лекцию по ссылке: {url}",

  // CitationChip three-dot menu
  citationSaveAsNote: "Сохранить как заметку",
  citationOpenInStudio: "Открыть в Студии",
  citationAddLectureToPlaylist: "Добавить лекцию в плейлист",
  recentSessionsLabel: "Недавние чаты",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5м`, `2ч`, `3д`). */
  timeJustNow: "только что",
  timeYesterday: "вчера",
  timeUnitMinute: "м",
  timeUnitHour: "ч",
  timeUnitDay: "д",
  timeUnitWeek: "нед",
  timeUnitMonth: "мес",
  timeUnitYear: "г",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Думаю…",
    searching_corpus: "Ищу в записях…",
    composing_answer: "Пишу ответ…",
    preparing_action: "Готовлю…",
    browsing_catalog: "Смотрю каталог…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Подбираю вопросы…",
  },
}
