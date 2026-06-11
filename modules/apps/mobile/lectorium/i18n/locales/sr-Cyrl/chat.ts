// AUTO-GENERATED from ../sr-Latn by modules/tools/sr-transliterate/generate-sr-cyrl.mjs
// Do not edit by hand — re-run the generator instead.
export default {
  title: "Ћаскање",
  placeholder: "Поставите питање",
  send: "Пошаљи",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Заустави",
  sending: "Размишљам…",
  emptyStateTitle: "Како могу да помогнем?",
  emptyState: "Питајте било шта — потражићу у снимцима.",
  newSession: "Ново ћаскање",
  history: "Историја ћаскања",
  historyEmpty: "Још нема ниједног ћаскања.",
  searchPlaceholder: "Претражи историју",
  searchEmpty: "Нема резултата",
  untitledSession: "Без наслова",
  clearHistory: "Обриши историју ћаскања",
  clearHistoryConfirm: "Обрисати сва ћаскања и поруке? Ова радња се не може поништити.",
  clearedToast: "Историја ћаскања је обрисана.",
  citationActionHeader: "Отвори цитат",
  citationOpen: "Отвори предавање",
  citationListen: "Преслушај исечак",
  citationLoading: "Учитавам…",
  citationOpenFull: "Отвори цело предавање",
  citationDetailsTitle: "Детаљи цитата",
  citationNoAudio: "Аудио за овај цитат није доступан",
  citationLoadFailed: "Није могуће учитати исечак",
  citationAddedToPlaylist: "Додато на листу нумера",
  citationAddFailed: "Није могуће додати на листу нумера",
  citationMtBadge: "Аутоматски преведено",
  citationViewOriginal: "прикажи оригинал",
  citationViewTranslated: "назад",
  lectureCardMissing: "Предавање није доступно у локалном каталогу.",
  errRate: "Превише захтева. Покушајте за минут.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Превише захтева. Покушајте {when}.",
  errNetwork: "Није могуће повезати се са ћаскањем. Проверите везу.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Нема интернета",
    body: "Покушаћемо поново чим се вратите на мрежу.",
    cta: "Покушај поново (аутоматски)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Сервер није доступан",
    body: "Покушајте за тренутак.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Ћаскање је привремено недоступно",
    body: "Тренутно нисмо могли да пошаљемо поруку. Покушајте мало касније.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Ограничење захтева",
  errQuotaUnknownBody: "Дневно ограничење је достигнуто, покушајте касније.",
  errServiceNotReady: "Сервис ћаскања се покреће. Покушајте ускоро.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Сервис ћаскања је вратио грешку. Покушајте мало касније.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Ауторизација није успела. Поново покрените апликацију.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Ова верзија апликације више није подржана. Ажурирајте је.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Потребно ажурирање",
      body: "Ћаскање користи нови протокол. Ажурирајте Lectorium да бисте наставили.",
      cta: "Отвори продавницу",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Привремени прекид",
      body: "Покушајте за тренутак.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "Веза је прекинута пре него што је одговор стигао.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Није могуће добити одговор.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Није могуће саставити одговор. Покушајте са конкретнијим питањем.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (прекинуто — веза је изгубљена)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (заустављено — превише позива алата)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (заустављено)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "за {n} с",
  retryInMinutes: "за {n} мин",
  retryAtTime: "у {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "сутра у {time}",
  retryNow: "сада",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Дневно ограничење порука је достигнуто",
  errQuotaAnonBody: "Пријавите се да добијете више порука дневно. Обнавља се {when}.",
  errQuotaFreeTitle: "Дневно ограничење порука је достигнуто",
  errQuotaFreeBody: "Shruti Pro укида дневно ограничење порука. Обнавља се {when}.",
  errQuotaProTitle: "Дневно ограничење је достигнуто",
  errQuotaProBody: "Искористили сте данашње поруке у ћаскању. Обнавља се {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Пријави се",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Дневно ограничење је достигнуто — покушајте касније",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Писање је паузирано, дневно ограничење се обнавља {when}",
  composeLimitedAriaLabelNoTime: "Писање је паузирано, дневно ограничење је достигнуто",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "{p}% искоришћено · обнавља се {date} у {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Сажетак тренутног предавања",
  suggestionRecapRecent: "Сажетак последњег предавања",
  followupAriaLabel: "Предложено питање: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Шта значи овај одломак?",
    "Објасни једноставним речима",
    "Дај ми више контекста",
    "Из ког је ово списа?",
  ],
  suggestions: [
    "Где сам стао?", // user_tracks_list(status='in_progress')
    "Листа по Гити, погл. 2", // propose_playlist
    "Предавања о BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Шта сам слушао ове недеље", // user_tracks_list(since=now-7d)
    "Шта даље да слушам?", // user_recommendations_get
    "О бхакти", // chunks_search (semantic)
    "Шта је душа?", // chunks_search (semantic)
    "Јутарње шетње у Бомбају", // list_tracks(location=Bombay, tag=morning_walk)
    "Разговори у Вриндавану", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF последњег предавања", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Ко је Кришна?",
    "Зашто патимо?",
    "Шта је карма?",
    "Шта је реинкарнација?",
    "Зашто певати мантру?",
    "Шта је бхакти?",
    "Ко је гуру?",
    "Зашто читати „Бхагавад-гīту“?",
    "Зашто вегетаријанство?",
    "Шта је смисао живота?",
    "Шта се дешава после смрти?",
    "Шта је дхарма?",
    "Ко је Шрила Прабхупада?",
    "Одакле да почнем праксу?",
    "Како развити љубав према Богу?",
    "Шта је свето име?",
    "Како медитирати на Кришну?",
  ],

  outlineTitle: "План",
  outlineMore: "Прикажи још {n}",
  outlineRecapPrompt: "Сажетак сегмента {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Додај све на листу нумера",
  trackListAddAllDone: "{n} предавања додато на листу нумера",
  trackListAddAllPartial: "{added} додато, {failed} неуспешно",
  trackListAddAllFailed: "Није могуће додати предавања на листу нумера.",
  actionOpenLibrary: "Отвори",
  actionOpenNotes: "Отвори",
  miniRowOpen: "Отвори предавање",

  noteSaved: "Белешка је сачувана",
  noteSaving: "Чувам белешку…",

  actionPdfKind: "Транскрипт предавања",
  actionPdfShare: "Подели",
  actionPdfShared: "Послато",
  actionPdfError: "Није могуће припремити PDF.",
  actionPdfDialog: "Подели транскрипт",

  actionDismiss: "Прескочи",
  actionDismissed: "Одбачено",
  actionRetry: "Покушај поново",
  actionDegraded: "Подаци картице радње недостају.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Копирај поруку",
  copyDone: "Копирано",
  /** Aria-label for the inline message Share button. */
  shareAction: "Подели поруку",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Добар одговор",
    thumbsDown: "Лош одговор",
    thanks: "Хвала на повратној информацији",
    failed: "Није могуће послати повратну информацију — покушајте поново",
    sheet: {
      title: "Шта је било погрешно?",
      hint: "Сва поља су опциона. Додирните „Пошаљи“ за слање.",
      categoryLabel: "Врста",
      categoryPlaceholder: "Изаберите једну (опционо)",
      commentLabel: "Коментар",
      commentPlaceholder: "Још нешто? (опционо)",
      submit: "Пошаљи",
    },
    categories: {
      off_topic: "Ван теме",
      no_results: "Ништа није пронађено",
      bad_citations: "Лоши цитати",
      wrong_language: "Погрешан језик",
      factually_wrong: "Чињенично нетачно",
      other: "Друго",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Дневни подсетник",
  proactiveSessionTitleSmartLibrary: "Паметна библиотека",
  proactiveSessionTitleNextShloka: "Следећи стих",
  proactiveSessionTitleUnfinishedLecture: "Недовршено предавање",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Били сте на претходном стиху — наставите по реду. Следећи је овде: {ref} „{title}“. Да га додам у вашу библиотеку?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Започели сте „{title}“, али га нисте довршили. Желите ли да наставите одакле сте стали?",

  proactiveSmartLibraryHintBody:
    "Желео бих да вам покажем Паметну библиотеку — Про функцију која вашу библиотеку држи пуну свежих предавања, без потребе да било шта ручно додајете.\n\nВи бирате критеријуме — омиљене ауторе, теме, изворе, дужину предавања — а Паметна библиотека тихо довлачи одговарајућа предавања до циљне дужине реда (нпр. 2 сата, 8 сати, 10 сати). Када се нешто заврши, аутоматски се архивира, па ред остаје свеж.\n\nКорисно за путовања и шетње, када не желите да губите време бирајући шта даље да слушате.",
  proactiveEnableNotificationsBody:
    "Слушате неколико дана заредом — леп ритам. Желео бих да предложим подешавање дневног подсетника да га не бисте изгубили.\n\nТо је једно нежно локално обавештење у време које изаберете (почећу са 07:00, можете га променити било када у Подешавањима). Нема оптерећења мреже — живи на вашем уређају и оглашава се само када дође време.\n\nКорисно као дневно сидро: мали подстицај да вас предавање чека кад год вам дан дозволи.",

  actionEnableReminderTitle: "Дневни подсетник",
  actionEnableReminderBody:
    "Изаберите време сваког дана и подсетићу вас да дођете да слушате. Касније можете променити или искључити у Подешавањима.",
  actionEnableReminderConfirm: "Укључи",
  actionEnableReminderDone: "Дневни подсетник је подешен.",
  actionEnableReminderError: "Није могуће омогућити обавештења.",

  actionConfigureSmartLibraryTitle: "Паметна библиотека",
  actionConfigureSmartLibraryBody:
    "Држите свежа предавања о вашим темама у реду, офлајн. Могу да вам унапред попуним ове филтере.",
  actionConfigureSmartLibraryConfirm: "Подеси",
  actionConfigureSmartLibraryDone: "Отворено у Подешавањима.",
  actionConfigureSmartLibraryError: "Није могуће отворити Паметну библиотеку.",
  actionConfigureSmartLibraryChipAuthors: "{n} аутора",
  actionConfigureSmartLibraryChipTopics: "{n} тема",
  actionConfigureSmartLibraryChipSources: "{n} извора",
  actionConfigureSmartLibraryChipLocations: "{n} локација",
  actionConfigureSmartLibraryChipLanguages: "{n} језика",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Откључајте Паметну библиотеку, Студио за белешке и остатак Про пакета да извучете највише из апликације.",
  actionUpgradeToProConfirm: "Погледај Про",
  actionUpgradeToProDone: "Страница претплате је отворена.",
  actionUpgradeToProError: "Није могуће отворити екран надоградње.",

  actionQueueNextTrackTitle: "Додај у библиотеку",
  actionQueueNextTrackConfirm: "Додај",
  actionQueueNextTrackDone: "Додато у библиотеку.",
  actionQueueNextTrackError: "Није могуће додати ово предавање.",

  citationSaveAsNote: "Сачувај као белешку",
  citationOpenInStudio: "Отвори у Студију",
  citationAddLectureToPlaylist: "Додај предавање на листу нумера",
  recentSessionsLabel: "Недавна ћаскања",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "управо сада",
  timeYesterday: "јуче",
  timeUnitMinute: "мин",
  timeUnitHour: "ч",
  timeUnitDay: "д",
  timeUnitWeek: "нед",
  timeUnitMonth: "мес",
  timeUnitYear: "г",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Размишљам…",
    searching_corpus: "Претражујем снимке…",
    composing_answer: "Пишем одговор…",
    preparing_action: "Припремам…",
    browsing_catalog: "Прегледам каталог…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Бирам питања…",
  },
}
