export default {
  title: "Чат",
  placeholder: "Поставте запитання",
  send: "Надіслати",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Зупинити",
  sending: "Думаю…",
  emptyStateTitle: "Чим допомогти?",
  emptyState: "Запитайте будь-що — пошукаю в записах.",
  newSession: "Новий чат",
  history: "Історія чатів",
  historyEmpty: "Поки що немає жодного чату.",
  searchPlaceholder: "Пошук в історії",
  searchEmpty: "Нічого не знайдено",
  untitledSession: "Без назви",
  clearHistory: "Очистити історію чатів",
  clearHistoryConfirm: "Видалити всі чати й повідомлення? Цю дію не можна скасувати.",
  clearedToast: "Історію чатів очищено.",
  citationActionHeader: "Відкрити цитату",
  citationOpen: "Відкрити лекцію",
  citationListen: "Прослухати фрагмент",
  citationLoading: "Завантажую…",
  citationOpenFull: "Відкрити повну лекцію",
  citationDetailsTitle: "Деталі цитати",
  citationNoAudio: "Аудіо для цієї цитати недоступне",
  citationLoadFailed: "Не вдалося завантажити фрагмент",
  citationAddedToPlaylist: "Додано до плейлиста",
  citationAddFailed: "Не вдалося додати до плейлиста",
  citationMtBadge: "Перекладено автоматично",
  citationViewOriginal: "Покажи оригінал",
  citationViewTranslated: "Покажи переклад",
  lectureCardMissing: "Лекції немає в локальному каталозі.",
  errRate: "Забагато запитів. Спробуйте за хвилину.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Забагато запитів. Спробуйте {when}.",
  errNetwork: "Не вдалося зв'язатися з чатом. Перевірте з'єднання.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Немає інтернету",
    body: "Повторимо, щойно з'явиться мережа.",
    cta: "Повторити (авто)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Сервер недоступний",
    body: "Спробуйте за хвилину.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Чат тимчасово недоступний",
    body: "Не вдалося надіслати повідомлення. Спробуйте трохи пізніше.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Ліміт запитів",
  errQuotaUnknownBody: "Денний ліміт вичерпано, спробуйте пізніше.",
  errServiceNotReady: "Сервіс чату запускається. Спробуйте за хвилину.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Сервіс чату відповів помилкою. Спробуйте трохи пізніше.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Не вдалося авторизуватися. Перезапустіть застосунок.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Ця версія застосунку більше не підтримується. Оновіть.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Потрібне оновлення",
      body: "Чат працює за новим протоколом. Оновіть Lectorium, щоб продовжити.",
      cta: "До магазину",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Сервіс тимчасово недоступний",
      body: "Спробуйте за хвилину.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "З'єднання обірвалося раніше, ніж надійшла відповідь.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Не вдалося отримати відповідь.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Не вдалося скласти відповідь. Спробуйте більш конкретне запитання.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (обірвано — з'єднання втрачено)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (зупинено — забагато викликів інструментів)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (зупинено)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "через {n} с",
  retryInMinutes: "через {n} хв",
  retryAtTime: "о {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "завтра о {time}",
  retryNow: "зараз",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Денний ліміт повідомлень вичерпано",
  errQuotaAnonBody: "Увійдіть, щоб отримати більше повідомлень на день. Оновиться {when}.",
  errQuotaFreeTitle: "Денний ліміт повідомлень вичерпано",
  errQuotaFreeBody: "Shruti Pro знімає денний ліміт повідомлень. Оновиться {when}.",
  errQuotaProTitle: "Денний ліміт вичерпано",
  errQuotaProBody: "Ви використали сьогоднішні повідомлення чату. Оновиться {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Увійти",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Денний ліміт вичерпано — спробуйте пізніше",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Введення призупинено, денний ліміт оновиться {when}",
  composeLimitedAriaLabelNoTime: "Введення призупинено, денний ліміт вичерпано",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% використано · оновиться {date} о {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Стисло про поточну лекцію",
  suggestionRecapRecent: "Стисло про останню лекцію",
  followupAriaLabel: "Запропоноване продовження: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Що означає цей фрагмент?",
    "Поясніть простими словами",
    "Дайте більше контексту",
    "З якого це писання?",
  ],
  suggestions: [
    "На чому я зупинився?", // user_tracks_list(status='in_progress')
    "Плейлист за Гітою, гл. 2", // propose_playlist
    "Лекції за БҐ 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Що я слухав цього тижня", // user_tracks_list(since=now-7d)
    "Що послухати далі?", // user_recommendations_get
    "Про бгакті", // chunks_search (semantic)
    "Що таке душа?", // chunks_search (semantic)
    "Ранкові прогулянки в Бомбеї", // list_tracks(location=Bombay, tag=morning_walk)
    "Бесіди у Вріндавані", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF останньої лекції", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Хто такий Крішна?",
    "Чому ми страждаємо?",
    "Що таке карма?",
    "Що таке реінкарнація?",
    "Навіщо повторювати мантру?",
    "Що таке бгакті?",
    "Хто такий гуру?",
    "Навіщо читати «Бгаґавад-ґіту»?",
    "Навіщо вегетаріанство?",
    "У чому сенс життя?",
    "Що відбувається після смерті?",
    "Що таке дгарма?",
    "Хто такий Шріла Прабгупада?",
    "З чого почати практику?",
    "Як розвинути любов до Бога?",
    "Що таке святе ім'я?",
    "Як медитувати на Крішну?",
  ],

  outlineTitle: "План",
  outlineMore: "Показати ще {n}",
  outlineRecapPrompt: "Стисло про сегмент {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Додати всі до плейлиста",
  trackListAddAllDone: "{n} лекцій додано до плейлиста",
  trackListAddAllPartial: "{added} додано, {failed} не вдалося",
  trackListAddAllFailed: "Не вдалося додати лекції до плейлиста.",
  actionOpenLibrary: "Відкрити",
  actionOpenNotes: "Відкрити",
  miniRowOpen: "Відкрити лекцію",

  noteSaved: "Нотатку збережено",
  noteSaving: "Зберігаю нотатку…",

  actionPdfKind: "Транскрипт лекції",
  actionPdfShare: "Поділитися",
  actionPdfShared: "Надіслано",
  actionPdfError: "Не вдалося підготувати PDF.",
  actionPdfDialog: "Поділитися транскриптом",

  actionDismiss: "Пропустити",
  actionDismissed: "Відхилено",
  actionRetry: "Повторити",
  actionDegraded: "Дані картки дії відсутні.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Копіювати повідомлення",
  copyDone: "Скопійовано",
  /** Aria-label for the inline message Share button. */
  shareAction: "Поділитися повідомленням",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Гарна відповідь",
    thumbsDown: "Погана відповідь",
    thanks: "Дякуємо за відгук",
    failed: "Не вдалося надіслати відгук — спробуйте ще раз",
    sheet: {
      title: "Що було не так?",
      hint: "Усі поля необов'язкові. Натисніть «Надіслати», щоб відправити.",
      categoryLabel: "Тип",
      categoryPlaceholder: "Виберіть один (необов'язково)",
      commentLabel: "Коментар",
      commentPlaceholder: "Щось іще? (необов'язково)",
      submit: "Надіслати",
    },
    categories: {
      off_topic: "Не за темою",
      no_results: "Нічого не знайдено",
      bad_citations: "Погані цитати",
      wrong_language: "Не та мова",
      factually_wrong: "Фактично неправильно",
      other: "Інше",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Щоденне нагадування",
  proactiveSessionTitleSmartLibrary: "Розумна бібліотека",
  proactiveSessionTitleNextShloka: "Лекція з наступного вірша",
  proactiveSessionTitleUnfinishedLecture: "Незавершена лекція",
  proactiveSessionTitleInactivity: "Поверніться до практики",
  proactiveInactivityWelcomeBody:
    "Давно вас не було. Свіжі лекції чекають — відкрийте бібліотеку й продовжуйте з місця, де зупинилися.",

  // Weekly digest — summary of the user's listening over the past 7 days.
  weeklyDigestTitle: "Ваш тиждень",
  weeklyDigestTotalTime: "Загальний час прослуховування",
  weeklyDigestLectures: "Лекцій за тиждень",
  weeklyDigestStreak: "Днів поспіль",
  weeklyDigestCompleted: "Завершено",
  weeklyDigestEmpty:
    "Цього тижня ви нічого не слухали — оберіть щось свіже, щоб повернутися в ритм.",
  weeklyDigestMore: "+{count} ще",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Ви були на попередньому вірші — продовжуйте за порядком. Наступний тут: {ref} «{title}». Додати його до бібліотеки?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Ви почали «{title}», але не завершили. Продовжити з місця, де зупинилися?",

  proactiveSmartLibraryHintBody:
    "Хочу показати вам Розумну бібліотеку — функцію Pro, яка тримає вашу бібліотеку повною свіжих лекцій без потреби щось додавати вручну.\n\nВи обираєте критерії — улюблених авторів, теми, джерела, тривалість лекцій — і Розумна бібліотека тихо підтягує відповідні лекції до бажаної тривалості черги (наприклад, 2 години, 8 годин, 10 годин). Коли щось завершено, воно автоматично архівується, тож черга залишається свіжою.\n\nЗручно для поїздок і прогулянок, коли не хочеться витрачати час на вибір, що слухати далі.",
  proactiveEnableNotificationsBody:
    "Ви слухаєте кілька днів поспіль — гарний ритм. Хочу запропонувати налаштувати щоденне нагадування, щоб його не втратити.\n\nЦе одне м'яке локальне сповіщення в обраний вами час (почну з 07:00, ви можете змінити це будь-коли в Налаштуваннях). Жодного навантаження на мережу — воно живе на вашому пристрої й спрацьовує лише тоді, коли настає час.\n\nКорисно як щоденний орієнтир: маленький нагад, що лекція чекає, щойно дозволить ваш день.",

  actionEnableReminderTitle: "Щоденне нагадування",
  actionEnableReminderBody:
    "Виберіть час щодня, і я нагадаю вам прийти послухати. Пізніше можна змінити або вимкнути в Налаштуваннях.",
  actionEnableReminderConfirm: "Увімкнути",
  actionEnableReminderDone: "Щоденне нагадування налаштовано.",
  actionEnableReminderError: "Не вдалося ввімкнути сповіщення.",

  actionConfigureSmartLibraryTitle: "Розумна бібліотека",
  actionConfigureSmartLibraryBody:
    "Тримайте свіжі лекції за вашими темами в черзі офлайн. Я можу заздалегідь заповнити ці фільтри за вас.",
  actionConfigureSmartLibraryConfirm: "Налаштувати",
  actionConfigureSmartLibraryDone: "Відкрито в Налаштуваннях.",
  actionConfigureSmartLibraryError: "Не вдалося відкрити Розумну бібліотеку.",
  actionConfigureSmartLibraryChipAuthors: "{n} авторів",
  actionConfigureSmartLibraryChipTopics: "{n} тем",
  actionConfigureSmartLibraryChipSources: "{n} джерел",
  actionConfigureSmartLibraryChipLocations: "{n} локацій",
  actionConfigureSmartLibraryChipLanguages: "{n} мов",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Відкрийте Розумну бібліотеку, Студію нотаток та решту Pro, щоб отримати максимум від застосунку.",
  actionUpgradeToProConfirm: "Дивитися Pro",
  actionUpgradeToProDone: "Сторінку підписки відкрито.",
  actionUpgradeToProError: "Не вдалося відкрити екран оновлення.",

  actionQueueNextTrackTitle: "Додати до бібліотеки",
  actionQueueNextTrackConfirm: "Додати",
  actionQueueNextTrackDone: "Додано до бібліотеки.",
  actionQueueNextTrackError: "Не вдалося додати цю лекцію.",

  citationSaveAsNote: "Зберегти як нотатку",
  citationOpenInStudio: "Відкрити в Студії",
  citationAddLectureToPlaylist: "Додати лекцію до плейлиста",
  recentSessionsLabel: "Нещодавні чати",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "щойно",
  timeYesterday: "учора",
  timeUnitMinute: "хв",
  timeUnitHour: "год",
  timeUnitDay: "д",
  timeUnitWeek: "тиж",
  timeUnitMonth: "міс",
  timeUnitYear: "р",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Думаю…",
    searching_corpus: "Шукаю в записах…",
    composing_answer: "Пишу відповідь…",
    preparing_action: "Готую…",
    browsing_catalog: "Переглядаю каталог…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Підбираю запитання…",
  },
}
