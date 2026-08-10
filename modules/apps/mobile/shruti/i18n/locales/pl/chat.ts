export default {
  title: "Czat",
  placeholder: "Zadaj pytanie",
  send: "Wyślij",
  /** Composer button label while a turn is streaming — the send icon
   *  swaps to a stop icon and tapping it aborts the SSE stream. */
  stop: "Zatrzymaj",
  sending: "Myślę…",
  emptyStateTitle: "W czym mogę pomóc?",
  emptyState: "Zapytaj o cokolwiek — poszukam w nagraniach.",
  newSession: "Nowy czat",
  history: "Historia czatów",
  historyEmpty: "Nie ma jeszcze żadnych czatów.",
  searchPlaceholder: "Przeszukaj historię",
  searchEmpty: "Brak wyników",
  untitledSession: "Czat bez tytułu",
  clearHistory: "Wyczyść historię czatów",
  clearHistoryConfirm: "Usunąć wszystkie sesje i wiadomości czatu? Tego nie można cofnąć.",
  clearedToast: "Historia czatów wyczyszczona.",
  citationActionHeader: "Otwórz cytat",
  citationOpen: "Otwórz wykład",
  citationListen: "Posłuchaj fragmentu",
  citationLoading: "Wczytuję…",
  citationOpenFull: "Otwórz pełny wykład",
  citationDetailsTitle: "Szczegóły cytatu",
  citationNoAudio: "Brak audio dla tego cytatu",
  citationLoadFailed: "Nie udało się wczytać fragmentu",
  citationAddedToPlaylist: "Dodano do playlisty",
  citationAddFailed: "Nie udało się dodać do playlisty",
  citationMtBadge: "Przetłumaczone automatycznie",
  citationViewOriginal: "Pokaż oryginał",
  citationViewTranslated: "Pokaż tłumaczenie",
  lectureCardMissing: "Wykład niedostępny w lokalnym katalogu.",
  errRate: "Zbyt wiele zapytań. Spróbuj ponownie za minutę.",
  /** Rate-limit copy with a deadline placeholder. `{when}` is composed by
   *  the bubble — "in 12s", "in 4 min", or "at 18:30" depending on how
   *  far out the 429 `Retry-After` lands. */
  errRateAfter: "Zbyt wiele zapytań. Spróbuj ponownie {when}.",
  errNetwork: "Nie udało się połączyć z czatem. Sprawdź połączenie.",
  /** Device-offline failure (navigator.onLine === false). Distinct from
   *  `errNetwork` (server unreachable while online) and `errServiceNotReady`
   *  (5xx) — the bubble auto-retries when the OS reports the connection
   *  is back, so the CTA reads as automatic rather than manual. */
  errOffline: {
    title: "Brak internetu",
    body: "Ponowię próbę, gdy wrócisz do sieci.",
    cta: "Ponów (auto)",
  },
  /** Generic server-unreachable copy used for http_5xx responses, kept
   *  separate from `errServiceNotReady` so we can iterate the warming-up
   *  wording without affecting plain 5xx UX. */
  errServer: {
    title: "Nie udało się połączyć z serwerem",
    body: "Spróbuj ponownie za chwilę.",
  },
  /** SSE `chat_unavailable` — the chat backend can't reach any LLM right
   *  now (out of credits, provider key rejected, provider down). Not the
   *  user's fault and transient, so calm copy + a Retry. */
  errUnavailable: {
    title: "Czat jest tymczasowo niedostępny",
    body: "Nie udało nam się teraz wysłać Twojej wiadomości. Spróbuj ponownie nieco później.",
  },
  /** Unknown-tier fallback. Shown when the server returns a 429 with a
   *  tier value the client doesn't recognise (schema drift, typo,
   *  enterprise tier added server-side before the mobile bump). Keeps
   *  the user out of an "empty title + generic body" half-state. */
  errQuotaUnknownTitle: "Limit zapytań",
  errQuotaUnknownBody: "Dzienny limit wyczerpany, spróbuj później.",
  errServiceNotReady: "Usługa czatu się uruchamia. Spróbuj ponownie za chwilę.",
  /** Server-side exception inside the LLM loop (provider timeout, key
   *  expired, tool crash). Distinct from `errNetwork` — the connection
   *  itself worked. */
  errAgent: "Usługa czatu zwróciła błąd. Spróbuj ponownie za chwilę.",
  /** HTTP 401/403. App token rejected; user can't fix this in-place. */
  errAuth: "Autoryzacja nie powiodła się. Uruchom aplikację ponownie, aby spróbować jeszcze raz.",
  /** HTTP 426 — server is on a newer protocol and refuses our request. */
  errProtocol: "Ta wersja aplikacji nie jest już obsługiwana. Zaktualizuj ją.",
  /** Toast surfaced on HTTP 426 — server demands a newer protocol
   *  version than we sent. CTA opens the matching app store. */
  error: {
    protocolMismatch: {
      title: "Wymagana aktualizacja",
      body: "Czat używa nowego protokołu. Zaktualizuj Shruti, aby kontynuować.",
      cta: "Otwórz sklep",
    },
    /** Toast surfaced on HTTP 503 `rate_limit_backend_unavailable` —
     *  the rate-limit backend (Redis) is down, server can't admit us. */
    backendUnavailable: {
      title: "Tymczasowa awaria",
      body: "Spróbuj ponownie za chwilę.",
    },
  },
  /** SSE connection dropped after handshake but before `done`. */
  errStreamDropped: "Połączenie zerwało się, zanim nadeszła odpowiedź.",
  /** Catch-all for `no_body`, `empty`, or any code we haven't seen yet. */
  errUnknown: "Nie udało się uzyskać odpowiedzi.",
  /** Agent hit MAX_TOOL_TURNS without producing a final answer. */
  errMaxTurns: "Nie udało się ułożyć odpowiedzi. Spróbuj zadać bardziej konkretne pytanie.",
  /** Appended to an assistant bubble whose stream ended without `done`. */
  errTruncatedStream: " (przerwano — połączenie zerwane)",
  /** Appended when the agent hit MAX_TOOL_TURNS without a final answer. */
  errTruncatedTurns: " (zatrzymano — zbyt wiele wywołań narzędzi)",
  /** Appended to an assistant bubble the user explicitly stopped mid-
   *  stream via the composer's stop button. Neutral copy — distinct
   *  from `errTruncated*` (which suggests something went wrong). */
  errStopped: " (zatrzymano)",
  /** Relative "{when}" fragments composed into errRateAfter. */
  retryInSeconds: "za {n} s",
  retryInMinutes: "za {n} min",
  retryAtTime: "o {time}",
  /** Used when the reset clock lands on the user's local NEXT day —
   *  server's resets_at_epoch is next UTC midnight, so for users east of
   *  UTC the same "05:00" can mean tomorrow morning, not later today.
   *  Bare "at 05:00" without the day word turned out to mislead users
   *  ("is that today or tomorrow?") so we make it explicit. */
  retryAtTimeTomorrow: "jutro o {time}",
  retryNow: "teraz",

  // ── Tier-aware quota copy (Phase 5) ───────────────────────────────────
  // The bubble's InlineNotice picks one of these three (anon / free / pro)
  // based on the `tier` field the server echoes in the 429 body. Old
  // servers without tier fall back to errRate / errRateAfter above.
  //
  // Copy intentionally omits the per-tier message count — the server
  // sets those numbers in config.py and we don't want to chase the
  // strings every time we tune. The "{when}" placeholder shows the
  // actual reset boundary so users still know how long the wait is.
  errQuotaAnonTitle: "Osiągnięto dzienny limit wiadomości",
  errQuotaAnonBody: "Zaloguj się, aby otrzymać więcej wiadomości czatu dziennie. Reset {when}.",
  errQuotaFreeTitle: "Osiągnięto dzienny limit wiadomości",
  errQuotaFreeBody: "Shruti Pro znosi dzienny limit wiadomości. Reset {when}.",
  errQuotaProTitle: "Osiągnięto dzienny limit",
  errQuotaProBody: "Wykorzystałeś dzisiejsze wiadomości czatu. Reset {when}.",
  /** CTAs under quota InlineNotices. Anon → opens Settings (where the
   *  social-sign-in buttons live). Free → opens the paywall page,
   *  deep-linked to the chat-benefit slide. */
  signInForMoreCta: "Zaloguj się",
  upgradeToProCta: "Shruti Pro",

  // ── Composer lockdown (Phase 6) ───────────────────────────────────────
  // The input placeholder is now always the static prompt — it no longer
  // carries limit copy. `composeLimitedPlaceholderNoTime` is reused as the
  // usage chip's fallback when the composer is locked but no usage
  // snapshot is available.
  composeLimitedPlaceholderNoTime: "Limit wyczerpany — spróbuj później",
  /** aria-label set on the textarea + send button while the composer is
   *  locked. Screen readers announce this in place of the static
   *  placeholder copy. `{when}` is built from `retryAtTime` /
   *  `retryAtTimeTomorrow`. */
  composeLimitedAriaLabel: "Pisanie wstrzymane, dzienny limit zresetuje się {when}",
  composeLimitedAriaLabelNoTime: "Pisanie wstrzymane, dzienny limit wyczerpany",

  /** Per-day usage chip above the composer. Visible to every tier once
   *  ≥50 % of the daily allowance is consumed. Same percent-based label
   *  across tiers (no separate free/pro copy — the bucket size differs
   *  by tier but the "how full am I" framing reads the same). Tap on
   *  Free/anon opens the paywall directly; Pro renders the chip as a
   *  static info badge. */
  usage: {
    chip: "wykorzystano {p}% · reset {date} o {time}",
  },

  // Each chip showcases ONE agent feature, not a topic. 2-4 words max.
  suggestionRecapCurrent: "Streść bieżący wykład",
  suggestionRecapRecent: "Streść ostatni wykład",
  followupAriaLabel: "Sugerowana kontynuacja: {text}",
  // Static fallback chips for a focus fragment when the server's
  // /questions endpoint returns an empty list (LLM failure, endpoint
  // not deployed yet, etc). Keeps the affordance visible so the user
  // can still seed a question without having to compose from scratch.
  focusFallbackSuggestions: [
    "Co oznacza ten fragment?",
    "Wyjaśnij prostymi słowami",
    "Podaj więcej kontekstu",
    "Z którego pisma to pochodzi?",
  ],
  suggestions: [
    "Gdzie skończyłem?", // user_tracks_list(status='in_progress')
    "Playlista o Gicie rozdz. 2", // propose_playlist
    "Wykłady o BG 2.11–20", // list_tracks(ref_prefix='2', ref_from=11, ref_to=20)
    "Czego słuchałem w tym tygodniu", // user_tracks_list(since=now-7d)
    "Czego posłuchać dalej?", // user_recommendations_get
    "O bhakti", // chunks_search (semantic)
    "Czym jest dusza?", // chunks_search (semantic)
    "Poranne spacery w Bombaju", // list_tracks(location=Bombay, tag=morning_walk)
    "Rozmowy we Vrindavanie", // list_tracks(location=Vrindavan, tag=conversation)
    "PDF ostatniego wykładu", // generate_track_pdf
    // Beginner-friendly philosophy questions — all route to chunks_search.
    "Kim jest Kryszna?",
    "Dlaczego cierpimy?",
    "Czym jest karma?",
    "Czym jest reinkarnacja?",
    "Po co intonować mantrę?",
    "Czym jest bhakti?",
    "Kim jest guru?",
    "Po co czytać Bhagawadgitę?",
    "Dlaczego wegetarianizm?",
    "Jaki jest sens życia?",
    "Co dzieje się po śmierci?",
    "Czym jest dharma?",
    "Kim jest Śrila Prabhupada?",
    "Od czego zacząć praktykę?",
    "Jak rozwinąć miłość do Boga?",
    "Czym jest święte imię?",
    "Jak medytować na Krysznę?",
  ],

  outlineTitle: "Konspekt",
  outlineMore: "Pokaż jeszcze {n}",
  outlineRecapPrompt: "Streść fragment {from}–{to}: {title}",

  trackListAddAllToPlaylist: "Dodaj wszystkie do playlisty",
  trackListAddAllDone: "{n} wykładów dodano do playlisty",
  trackListAddAllPartial: "{added} dodano, {failed} nie udało się",
  trackListAddAllFailed: "Nie udało się dodać wykładów do playlisty.",
  actionOpenLibrary: "Otwórz",
  actionOpenNotes: "Otwórz",
  miniRowOpen: "Otwórz wykład",

  noteSaved: "Notatka zapisana",
  noteSaving: "Zapisuję notatkę…",
  actionNoteError: "Nie udało się zapisać notatki.",

  actionPdfKind: "Transkrypcja wykładu",
  actionPdfShare: "Udostępnij",
  actionPdfShared: "Wysłano",
  actionPdfError: "Nie udało się przygotować pliku PDF.",
  actionPdfDialog: "Udostępnij transkrypcję",

  actionDismiss: "Pomiń",
  actionDismissed: "Odrzucono",
  actionRetry: "Ponów",
  actionDegraded: "Brakuje danych karty akcji.",

  /** Aria-label and toast for the inline message Copy button. */
  copyAction: "Kopiuj wiadomość",
  copyDone: "Skopiowano",
  /** Aria-label for the inline message Share button. */
  shareAction: "Udostępnij wiadomość",

  /** Feedback (thumbs up/down + reason sheet on thumbs-down). */
  feedback: {
    thumbsUp: "Dobra odpowiedź",
    thumbsDown: "Zła odpowiedź",
    thanks: "Dziękujemy za opinię",
    failed: "Nie udało się wysłać opinii — spróbuj ponownie",
    sheet: {
      title: "Co było nie tak?",
      hint: "Wszystkie pola są opcjonalne. Dotknij Wyślij, aby przesłać.",
      categoryLabel: "Typ",
      categoryPlaceholder: "Wybierz jeden (opcjonalnie)",
      commentLabel: "Komentarz",
      commentPlaceholder: "Coś jeszcze? (opcjonalnie)",
      submit: "Wyślij",
    },
    categories: {
      off_topic: "Nie na temat",
      no_results: "Nic nie znaleziono",
      bad_citations: "Złe cytaty",
      wrong_language: "Zły język",
      factually_wrong: "Błędne merytorycznie",
      other: "Inne",
    },
  },

  // Session titles for autonomous tutorial-style proactive sessions.
  proactiveSessionTitleEnableReminder: "Codzienne przypomnienie",
  proactiveSessionTitleSmartLibrary: "Inteligentna biblioteka",
  proactiveSessionTitleNextShloka: "Wykład o następnym wersecie",
  proactiveSessionTitleUnfinishedLecture: "Niedokończony wykład",
  proactiveSessionTitleInactivity: "Wróć do swojej praktyki",
  proactiveSessionTitleWeeklyDigest: "Twój tydzień",
  proactiveInactivityWelcomeBody:
    "Minęło trochę czasu. Czekają na Ciebie świeże wykłady — otwórz bibliotekę i wróć tam, gdzie skończyłeś.",

  // Weekly digest — summary of the user's listening over the past week.
  weeklyDigestTitle: "Twój tydzień",
  weeklyDigestIntro: "Oto jak minął twój tydzień 🙏",
  weeklyDigestTotalTime: "Łączny czas słuchania",
  weeklyDigestLectures: "Wykłady w tym tygodniu",
  weeklyDigestStreak: "Seria dni",
  weeklyDigestCompleted: "Ukończone",
  weeklyDigestEmpty: "W tym tygodniu nic nie słuchałeś — wybierz coś świeżego i wróć do rytmu.",
  weeklyDigestMore: "+{count} więcej",

  // Pre-baked body for the `next_shloka` rule. `{ref}` is the verse
  // label (e.g. "2.14"); `{title}` is the localised catalog title. The
  // follow-up action card lives below as a marker.
  proactiveNextShlokaBody:
    "Byłeś przy poprzednim wersecie — kontynuuj po kolei. Następny jest tutaj: {ref} „{title}”. Dodać go do Twojej biblioteki?",

  // Pre-baked body for the `unfinished_lecture` rule. `{title}` is the
  // localised catalog title of the lecture the user left unfinished. The
  // follow-up `queue_next_track` action card lives below as a marker.
  proactiveUnfinishedLectureBody:
    "Zacząłeś „{title}”, ale go nie dokończyłeś. Chcesz wrócić tam, gdzie skończyłeś?",

  proactiveSmartLibraryHintBody:
    "Chciałbym pokazać Ci inteligentną bibliotekę — funkcję Pro, która utrzymuje Twoją bibliotekę pełną świeżych wykładów, bez potrzeby ręcznego dodawania czegokolwiek do kolejki.\n\nTy wybierasz kryteria — ulubionych autorów, tematy, źródła, długość wykładu — a inteligentna biblioteka po cichu dobiera pasujące wykłady do docelowej długości kolejki (np. 2 godziny, 8 godzin, 10 godzin). Gdy coś zostanie wysłuchane, automatycznie trafia do archiwum, więc kolejka pozostaje świeża.\n\nDobre na dojazdy i spacery, gdy nie chcesz tracić czasu na wybór, czego posłuchać dalej.",
  proactiveEnableNotificationsBody:
    "Słuchasz już kilka dni z rzędu — niezły rytm. Chciałbym zaproponować ustawienie codziennego przypomnienia, żebyś go nie stracił.\n\nTo jedno delikatne lokalne powiadomienie o wybranej przez Ciebie porze (zacznę od 07:00, możesz to zmienić w każdej chwili w Ustawieniach). Żadnego ruchu w sieci — żyje na Twoim urządzeniu i uruchamia się tylko wtedy, gdy nadejdzie czas.\n\nPrzydatne jako codzienna kotwica: drobne przypomnienie, że wykład czeka, kiedy tylko pozwoli Ci na to dzień.",

  actionEnableReminderTitle: "Codzienne przypomnienie",
  actionEnableReminderBody:
    "Wybierz porę każdego dnia, a przypomnę Ci, żebyś przyszedł posłuchać. Możesz to później zmienić lub wyłączyć w Ustawieniach.",
  actionEnableReminderConfirm: "Włącz",
  actionEnableReminderDone: "Codzienne przypomnienie ustawione.",
  actionEnableReminderError: "Nie udało się włączyć powiadomień.",

  actionConfigureSmartLibraryTitle: "Inteligentna biblioteka",
  actionConfigureSmartLibraryBody:
    "Miej świeże wykłady na swoje tematy w kolejce offline. Mogę wstępnie wypełnić te filtry za Ciebie.",
  actionConfigureSmartLibraryConfirm: "Skonfiguruj",
  actionConfigureSmartLibraryDone: "Otwarto w Ustawieniach.",
  actionConfigureSmartLibraryError: "Nie udało się otworzyć inteligentnej biblioteki.",
  actionConfigureSmartLibraryChipAuthors: "{n} autorów",
  actionConfigureSmartLibraryChipTopics: "{n} tematów",
  actionConfigureSmartLibraryChipSources: "{n} źródeł",
  actionConfigureSmartLibraryChipLocations: "{n} miejsc",
  actionConfigureSmartLibraryChipLanguages: "{n} języków",

  actionUpgradeToProTitle: "Shruti Pro",
  actionUpgradeToProBody:
    "Odblokuj inteligentną bibliotekę, Studio notatek i resztę Pro, aby w pełni wykorzystać aplikację.",
  actionUpgradeToProConfirm: "Zobacz Pro",
  actionUpgradeToProDone: "Otwarto stronę subskrypcji.",
  actionUpgradeToProError: "Nie udało się otworzyć ekranu subskrypcji.",

  actionQueueNextTrackTitle: "Dodaj do biblioteki",
  actionQueueNextTrackConfirm: "Dodaj",
  actionQueueNextTrackDone: "Dodano do biblioteki.",
  actionQueueNextTrackError: "Nie udało się dodać tego wykładu.",

  citationSaveAsNote: "Zapisz jako notatkę",
  citationOpenInStudio: "Otwórz w Studio",
  citationAddLectureToPlaylist: "Dodaj wykład do playlisty",
  recentSessionsLabel: "Ostatnie czaty",
  /** Short relative-time labels for RecentSessions. Localise the suffix
   *  only; the number is rendered by the component (`5m`, `2h`, `3d`). */
  timeJustNow: "przed chwilą",
  timeYesterday: "wczoraj",
  timeUnitMinute: "m",
  timeUnitHour: "h",
  timeUnitDay: "d",
  timeUnitWeek: "tyg",
  timeUnitMonth: "mies",
  timeUnitYear: "lat",

  // Server-streamed `status` event labels (SSE v1). Key matches the
  // `key` field on the status event — see backend `agent/events.py`.
  status: {
    thinking: "Myślę…",
    searching_corpus: "Szukam w nagraniach…",
    composing_answer: "Piszę odpowiedź…",
    preparing_action: "Przygotowuję…",
    browsing_catalog: "Przeglądam katalog…",
    // Shown on a focus card while `/questions` is in flight. Reuses
    // the chat.status.* slot so StatusPill picks it up — same dots
    // spinner + pill geometry as the assistant status indicator.
    picking_questions: "Dobieram pytania…",
  },
}
