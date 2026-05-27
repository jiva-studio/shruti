export default {
  title: "Чат",
  placeholder: "Спросите что-нибудь…",
  send: "Отправить",
  /** Подпись кнопки в композере, пока идёт стрим — иконка отправки
   *  меняется на стоп, тап прерывает SSE-стрим. */
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
  lectureCardMissing: "Лекция отсутствует в локальном каталоге.",
  errRate: "Слишком много запросов. Повторите через минуту.",
  /** Сообщение про rate-limit с дедлайном. `{when}` собирает бабл —
   *  «через 12 с», «через 4 мин» или «в 18:30», в зависимости от того,
   *  как далеко в будущем приходит 429 `Retry-After`. */
  errRateAfter: "Слишком много запросов. Повторите {when}.",
  errNetwork: "Не удалось связаться с чатом. Проверьте подключение.",
  /** Устройство офлайн (navigator.onLine === false). Отличается от
   *  `errNetwork` (нет сервера при онлайне) и `errServiceNotReady` (5xx) —
   *  бабл сам перезапросит, когда ОС сообщит о восстановлении связи. */
  errOffline: {
    title: "Нет подключения",
    body: "Повторим автоматически, как только сеть появится.",
    cta: "Повторить (авто)",
  },
  /** Серверный сбой 5xx. Держим отдельно от `errServiceNotReady`, чтобы
   *  можно было крутить «прогревающую» формулировку без влияния на обычный
   *  5xx-UX. */
  errServer: {
    title: "Сервер недоступен",
    body: "Попробуйте через минуту.",
  },
  /** Фолбэк для неизвестного тира. Показывается, когда сервер вернул 429
   *  с tier'ом, которого клиент не знает (схема разошлась, опечатка,
   *  enterprise на сервере раньше мобайла). Чтобы вместо пустого заголовка
   *  и generic-body пользователь увидел осмысленный текст. */
  errQuotaUnknownTitle: "Лимит запросов",
  errQuotaUnknownBody: "Дневной лимит исчерпан, попробуйте позже.",
  errServiceNotReady: "Сервис чата запускается. Попробуйте позже.",
  /** Серверный сбой внутри LLM-loop (таймаут провайдера, ключ протух,
   *  упал инструмент). Отличается от `errNetwork` — само соединение
   *  работает. */
  errAgent: "Сервис чата ответил ошибкой. Попробуйте чуть позже.",
  /** HTTP 401/403. Токен отклонён, пользователь не починит в моменте. */
  errAuth: "Не удалось авторизоваться. Перезапустите приложение.",
  /** HTTP 426 — сервер уже на новом протоколе и отклоняет нашу версию. */
  errProtocol: "Эта версия приложения больше не поддерживается. Обновите.",
  /** Тост для HTTP 426 — сервер требует более новую версию протокола.
   *  Кнопка ведёт в магазин приложений соответствующей платформы. */
  error: {
    protocolMismatch: {
      title: "Обновите приложение",
      body: "Чат работает по новому протоколу. Обновите Lectorium, чтобы продолжить.",
      cta: "В магазин",
    },
    /** Тост для HTTP 503 `rate_limit_backend_unavailable` — лимитер
     *  недоступен (Redis лёг), сервер не может пропустить запрос. */
    backendUnavailable: {
      title: "Сервис временно недоступен",
      body: "Попробуйте через минуту.",
    },
  },
  /** SSE-соединение оборвалось после хэндшейка, но до `done`. */
  errStreamDropped: "Связь оборвалась раньше, чем пришёл ответ.",
  /** Заглушка для `no_body`, `empty` и любых кодов, которые ещё не видели. */
  errUnknown: "Не удалось получить ответ.",
  /** Агент упёрся в MAX_TOOL_TURNS, не дав финального ответа. Сеть была в
   *  порядке — модель просто крутилась по тулам. Подсказываем переформулировать
   *  вместо неверного «нет связи». */
  errMaxTurns: "Не удалось собрать ответ. Попробуйте конкретнее или короче.",
  /** Дописывается в конец пузыря ассистента, если стрим оборвался без `done`. */
  errTruncatedStream: " (прервано — связь оборвалась)",
  /** Дописывается, когда агент уперся в лимит вызовов инструментов. */
  errTruncatedTurns: " (прервано — слишком много вызовов инструментов)",
  /** Дописывается, когда пользователь сам остановил стрим кнопкой
   *  «Стоп» в композере. Нейтральная формулировка — в отличие от
   *  `errTruncated*`, не намекает на сбой. */
  errStopped: " (остановлено)",
  /** Относительные «{when}»-фрагменты, подставляемые в errRateAfter. */
  retryInSeconds: "через {n} с",
  retryInMinutes: "через {n} мин",
  retryAtTime: "в {time}",
  /** Используется, когда сброс лимита приходится на локальный СЛЕДУЮЩИЙ
   *  день — серверный resets_at_epoch это полночь UTC, и для пользователей
   *  восточнее UTC те же «05:00» могут означать завтрашнее утро, а не
   *  «через пару часов сегодня». Без слова «завтра» это путало. */
  retryAtTimeTomorrow: "завтра в {time}",
  retryNow: "сейчас",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // Без конкретных чисел в строке — серверная конфигурация может
  // меняться, не хочется ловить расхождения. «{when}» подставляет
  // реальное время сброса.
  errQuotaAnonTitle: "Дневной лимит исчерпан",
  errQuotaAnonBody: "Войдите, чтобы получать больше сообщений в день. Обновится {when}.",
  errQuotaFreeTitle: "Дневной лимит исчерпан",
  errQuotaFreeBody: "С подпиской «Слушай Садху Pro» дневной лимит больше. Обновится {when}.",
  errQuotaProTitle: "Дневной лимит исчерпан",
  errQuotaProBody: "Сегодня сообщения в чате закончились. Обновится {when}.",
  signInForMoreCta: "Войти",
  upgradeToProCta: "Слушай Садху Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // `{when}` собирается из `retryAtTime` / `retryAtTimeTomorrow` —
  // если сброс лимита приходится на локальное «завтра», в строке
  // появляется слово «завтра», иначе просто «в HH:MM».
  composeLimitedPlaceholder: "Лимит обновится {when}",
  composeLimitedPlaceholderNoTime: "Лимит исчерпан — попробуйте позже",
  /** aria-label на textarea + send-кнопке, пока ввод заблокирован
   *  лимитом. Экранные читалки озвучат это вместо ротации placeholder'а,
   *  которую они обычно не подхватывают. `{when}` — тот же фрагмент,
   *  что и в placeholder'е. */
  composeLimitedAriaLabel: "Ввод приостановлен, дневной лимит обновится {when}",
  composeLimitedAriaLabelNoTime: "Ввод приостановлен, дневной лимит исчерпан",

  // Suggestion chips — each chip showcases ONE agent feature, not a topic.
  // Keep them 2-4 words so they fit one line.
  // The "recap" chip swaps between current / recent / generic to make
  // clear *which* lecture the agent will summarise.
  suggestionRecapCurrent: "Перескажи текущую лекцию",
  suggestionRecapRecent: "Перескажи последнюю лекцию",
  followupAriaLabel: "Подсказка: {text}",
  // Статический фолбэк для chip'ов фокусного фрагмента — показывается
  // когда сервер /questions вернул пустой список (LLM сбойнул, ручка
  // ещё не задеплоена, и т.п.). Чтобы кнопки для затравки всё равно
  // были под рукой и пользователю не пришлось формулировать с нуля.
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

  /** Aria-label и toast для inline-кнопки Copy под сообщением. */
  copyAction: "Скопировать сообщение",
  copyDone: "Скопировано",
  /** Aria-label для inline-кнопки Share под сообщением. */
  shareAction: "Поделиться сообщением",

  /** Фидбэк (👍/👎 + причина при 👎). */
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

  // Заголовки автономных tutorial-сессий, которые scheduler создаёт
  // когда правило срабатывает первый раз для пользователя.
  proactiveSessionTitleEnableReminder: "Ежедневное напоминание",
  proactiveSessionTitleSmartLibrary: "Умная библиотека",
  proactiveSessionTitleNextShloka: "Следующий шлок",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the canonical
  // verse label (e.g. "2.14"); `{title}` is the catalog title in the
  // user's locale. The follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Ты недавно слушал лекцию по предыдущему стиху — продолжай по порядку. Следующий уже есть: {ref} «{title}». Добавить в библиотеку?",

  proactiveSmartLibraryHintBody:
    "Хочу показать тебе умную библиотеку — это Pro-функция, которая держит твою библиотеку всегда наполненной свежими лекциями, без необходимости вручную их добавлять.\n\nТы выбираешь критерии — любимые авторы, темы, источники, длительность — и умная библиотека сама подтягивает подходящие лекции до целевого объёма очереди (например, 2 часа, 8 часов, 10 часов). Когда лекция дослушана — она автоматически уходит в архив, очередь остаётся свежей.\n\nХорошо для дороги и прогулок, когда не хочется тратить время на выбор того что слушать дальше.",
  proactiveEnableNotificationsBody:
    "Ты слушаешь несколько дней подряд — хороший ритм. Предлагаю настроить ежедневное напоминание, чтобы не сбить его.\n\nЭто одно мягкое локальное уведомление в выбранное тобой время (поставлю 07:00 по умолчанию, можно изменить в настройках). Сеть не задействована — уведомление живёт на устройстве и срабатывает только когда наступает время.\n\nПолезно как ежедневный якорь — короткое напоминание, что лекция ждёт, когда у тебя будет время.",

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

  actionUpgradeToProTitle: "Слушай Садху Pro",
  actionUpgradeToProBody: "Открой умную библиотеку, Студию заметок и остальные возможности Pro.",
  actionUpgradeToProConfirm: "Посмотреть Pro",
  actionUpgradeToProDone: "Окно подписки открыто.",
  actionUpgradeToProError: "Не удалось открыть подписку.",

  actionQueueNextTrackTitle: "Добавить в библиотеку",
  actionQueueNextTrackConfirm: "Добавить",
  actionQueueNextTrackDone: "Добавлено в библиотеку.",
  actionQueueNextTrackError: "Не удалось добавить лекцию.",

  // CitationChip three-dot menu
  citationSaveAsNote: "Сохранить как заметку",
  citationOpenInStudio: "Открыть в Студии",
  citationAddLectureToPlaylist: "Добавить лекцию в плейлист",
  recentSessionsLabel: "Недавние чаты",
  /** Короткие относительно-временные суффиксы для RecentSessions.
   *  Число рендерится компонентом (`5м`, `2ч`, `3д`). */
  timeJustNow: "только что",
  timeYesterday: "вчера",
  timeUnitMinute: "м",
  timeUnitHour: "ч",
  timeUnitDay: "д",
  timeUnitWeek: "нед",
  timeUnitMonth: "мес",
  timeUnitYear: "г",

  // Метки `status` SSE-события (протокол v1). Ключ должен совпадать с
  // полем `key` в событии — см. backend `agent/events.py`.
  status: {
    thinking: "Думаю…",
    searching_corpus: "Ищу в записях…",
    composing_answer: "Пишу ответ…",
    preparing_action: "Готовлю…",
    browsing_catalog: "Смотрю каталог…",
    // Показывается на focus-карточке пока `/questions` крутится.
    // Подсаживается в слот chat.status.*, чтобы StatusPill подхватил —
    // те же точки + геометрия, что у обычного статус-индикатора.
    picking_questions: "Подбираю вопросы…",
  },
}
