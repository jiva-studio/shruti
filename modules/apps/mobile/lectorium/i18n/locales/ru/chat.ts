export default {
  title: "Чат",
  placeholder: "Спросите что-нибудь…",
  send: "Отправить",
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
  showTab: "Вкладка «Чат»",
  showTabHint: "Добавляет вкладку «Чат» в нижнюю навигацию.",
  errRate: "Слишком много запросов. Повторите через минуту.",
  errNetwork: "Не удалось связаться с чатом. Проверьте подключение.",
  errServiceNotReady: "Сервис чата запускается. Попробуйте позже.",
  /** Агент упёрся в MAX_TOOL_TURNS, не дав финального ответа. Сеть была в
   *  порядке — модель просто крутилась по тулам. Подсказываем переформулировать
   *  вместо неверного «нет связи». */
  errMaxTurns: "Не удалось собрать ответ. Попробуйте конкретнее или короче.",
  /** Дописывается в конец пузыря ассистента, если стрим оборвался без `done`. */
  errTruncatedStream: " (прервано — связь оборвалась)",
  /** Дописывается, когда агент уперся в лимит вызовов инструментов. */
  errTruncatedTurns: " (прервано — слишком много вызовов инструментов)",
  /** Последний резерв для названия спасенного плейлиста, если запрос
   *  пользователя не годится как заголовок (пустой / пробелы). */
  fallbackPlaylistName: "Плейлист",

  // Suggestion chips — each chip showcases ONE agent feature, not a topic.
  // Keep them 2-4 words so they fit one line.
  // The "recap" chip swaps between current / recent / generic to make
  // clear *which* lecture the agent will summarise.
  suggestionRecapCurrent: "Перескажи текущую лекцию",
  suggestionRecapRecent: "Перескажи последнюю лекцию",
  suggestions: [
    "Где остановился?",            // continue_listening
    "Собери плейлист по Гите 2",  // propose_playlist
    "Что слушал на неделе?",       // search_my_history + now
    "Поищи в моих заметках",       // search_my_notes
    "Что послушать ещё?",          // recommend_next
    "Найди про варнашраму",        // search_transcripts (classic)
    "Утренние прогулки 1973",      // list_tracks (classic)
  ],

  // Outline card
  outlineTitle: "Оглавление",
  outlineMore: "Показать ещё {n}",
  /** Text injected when the user taps an outline chapter — the agent
   *  uses `user_context.focus` to find the actual range, so wording stays
   *  short and natural. */
  outlineRecapPrompt: "Перескажи фрагмент {from}–{to}: {title}",

  // Action cards — playlist
  actionPlaylistKind: "Предлагаю плейлист",
  actionPlaylistBadge: "{n} лекций",
  actionPlaylistMore: "и ещё {n} — развернуть",
  actionPlaylistConfirm: "Добавить в плейлист",
  actionPlaylistDone: "Лекции добавлены в плейлист",
  actionPlaylistError: "Не удалось создать плейлист.",
  actionOpenLibrary: "Открыть",
  actionOpenNotes: "Открыть",
  miniRowOpen: "Открыть лекцию",

  // Action cards — note
  actionNoteKind: "Сохранить как заметку",
  actionNoteConfirm: "Сохранить",
  actionNoteDone: "Заметка сохранена",
  actionNoteError: "Не удалось сохранить заметку.",
  noteSaved: "Заметка сохранена",
  noteSaving: "Сохраняю заметку…",

  // Action cards — common
  actionDismiss: "Не нужно",
  actionDismissed: "Действие отменено",
  actionRetry: "Повторить",
  actionDegraded: "Карточка действия повреждена.",

  // CitationChip three-dot menu
  citationSaveAsNote: "Сохранить как заметку",
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
}
