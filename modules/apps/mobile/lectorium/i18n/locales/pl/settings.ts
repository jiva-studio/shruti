export default {
  groups: {
    subscription: "Subskrypcja",
    account: "Konto",
    appearance: "Wygląd",
    library: "Biblioteka",
    chat: "Zapytaj Sadhu",
    contacts: "Skontaktuj się z nami",
    status: "Status",
    sadhana: "Sadhana",
    data: "Dane",
    help: "Pomoc",
    debug: "Debugowanie",
    danger: "Strefa zagrożenia",
    about: "O aplikacji",
  },
  libraryLanguages: {
    title: "Języki wykładów",
    description: "Pokazuj wykłady w tych językach w wyszukiwaniu, tematach i rekomendacjach.",
  },

  account: {
    signInCta: {
      title: "Zaloguj się",
      description: "Zachowaj swoje postępy",
    },
    signInWithGoogle: "Kontynuuj z Google",
    signInWithApple: "Kontynuuj z Apple",
    signInWithEmail: "Kontynuuj przez e-mail",
    email: {
      title: "Logowanie przez e-mail",
      emailStep: "Wyślemy jednorazowy kod na twój e-mail — hasło nie jest potrzebne.",
      emailLabel: "E-mail",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "Wyślij kod",
      codeStep: "Wpisz 6-cyfrowy kod, który wysłaliśmy na {email}.",
      codeLabel: "Kod",
      codePlaceholder: "6-cyfrowy kod",
      verify: "Zaloguj się",
      resend: "Wyślij kod ponownie",
      resendIn: "Ponownie za {seconds} s",
      changeEmail: "Zmień e-mail",
      errors: {
        invalidEmail: "Podaj prawidłowy adres e-mail.",
        invalidCode: "Kod jest nieprawidłowy lub wygasł.",
        throttled: "Odczekaj chwilę przed prośbą o kolejny kod.",
        disabled: "Logowanie przez e-mail jest teraz niedostępne.",
        network: "Brak połączenia. Sprawdź internet i spróbuj ponownie.",
        server: "Coś poszło nie tak po naszej stronie. Spróbuj ponownie za chwilę.",
        generic: "Coś poszło nie tak. Spróbuj ponownie.",
      },
    },
    signedIn: "Jesteś zalogowany",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Twoje postępy są bezpieczne",
    signOut: "Wyloguj się",
    signOutWipeToast:
      "Wylogowano. Twoje notatki i rozmowy pozostają na koncie i wrócą po ponownym zalogowaniu. Pobrane wykłady zostały usunięte z tego urządzenia i trzeba je pobrać ponownie.",
    signOutWipeToastChatLocal:
      "Wylogowano. Twoje notatki pozostają na koncie i wrócą po ponownym zalogowaniu. Synchronizacja rozmów była wyłączona, więc rozmowy były tylko na tym urządzeniu i zostały usunięte. Pobrane wykłady również usunięto — trzeba je pobrać ponownie.",
    signOutWipeUnsentSuffix:
      "Ostatnich zmian nie udało się wysłać przed wylogowaniem i zostały utracone.",
    deleteAccount: {
      title: "Usuń konto",
      confirmWipe: "Usuń konto i wymaż dane",
      confirmKeep: "Usuń konto, zachowaj moje dane",
      errorToast: "Nie udało się usunąć konta. Spróbuj ponownie.",
      alreadyDeletedToast: "Twoje konto zostało już usunięte.",
      rateLimitedToast: "Odczekaj chwilę przed kolejną próbą.",
      networkErrorToast: "Brak połączenia. Sprawdź internet i spróbuj ponownie.",
      serverErrorToast: "Coś poszło nie tak po naszej stronie. Spróbuj ponownie za chwilę.",
    },
  },

  subscription: {
    title: "Subskrypcja",
    description: "Zarządzanie subskrypcją",
    subscriptionIsActive: "Subskrypcja jest aktywna",
    tapToManage: "Dotknij, aby wyświetlić lub zarządzać",
    choose: 'Wesprzyj "Shruti"',
    subscribe: "Subskrybuj",
    trialBadge: "{days} dni za darmo",
    trialThenPrice: "potem {price} / {period}",
    startFreeTrial: "Rozpocznij bezpłatny okres próbny",
    trialDisclaimer:
      "Możesz anulować w dowolnym momencie. Po okresie próbnym subskrypcja odnowi się automatycznie.",
    disclaimer: "Możesz anulować w dowolnym momencie. Subskrypcja odnowi się automatycznie.",
    subscribed: "Subskrypcja zakończona",
    loading: "Wczytywanie opcji subskrypcji…",
    unavailable: "Zakupy w aplikacji nie są dostępne na tym urządzeniu.",
    unconfirmed: "Nie udało się potwierdzić subskrypcji. Jeśli już ją masz, dotknij „Przywróć”.",
    manage: "Zarządzaj subskrypcją",
    restore: "Przywróć",
    restored: "Twoja subskrypcja została pomyślnie przywrócona!",
    error: "Podczas operacji wystąpił błąd. Spróbuj ponownie.",
    noSubscriptionFound:
      "Nie znaleziono aktywnej subskrypcji. Wykup subskrypcję, aby uzyskać dostęp do funkcji premium.",
    thanks:
      "Dziękujemy za subskrypcję i wsparcie 🙏 Niech Twoje serce wypełni się szczęściem, a każdy dzień przybliża Cię do Prawdy. Cieszymy się, że jesteś z nami na tej drodze.",
    benefits: {
      progress: {
        title: "Śledź swoje postępy",
        description: "Śledź swoją passę słuchania i wróć tam, gdzie skończyłeś.",
      },
      andMore: {
        title: "I wiele więcej",
        description: "Ciągłe odtwarzanie, udostępnianie, studio notatek i wiele więcej.",
      },
      intro:
        "Wprowadzamy nowe funkcje i ulepszenia. Twoje wsparcie pomaga nam kontynuować rozwój i ulepszać produkt.",
      benefit0: {
        title: "Nowe wykłady",
        description: "Twoja subskrypcja pomaga nam dodawać nowe wykłady.",
      },
      benefit1: {
        title: "Zakładki",
        description: "Zapisuj kluczowe momenty wykładu, aby do nich wrócić lub udostępnić.",
      },
      benefit2: {
        title: "Inteligentna biblioteka",
        description: "Trzyma świeże wykłady na urządzeniu i usuwa wysłuchane.",
      },
      benefit3: {
        title: "Seminaria i kursy",
        description:
          "Dodawaj seminaria i kursy do playlisty, aby słuchać ich w dogodnej kolejności.",
      },
      benefit4: {
        title: "Dynamiczne kolekcje",
        description:
          "Twórz kolekcje wykładów, które będą automatycznie aktualizowane według zadanych kryteriów.",
      },
      sakha: {
        title: "Zapytaj Sadhu",
        description: "Przeszukuje wykłady, audio i książki i objaśnia nauki.",
      },
      autoScroll: {
        title: "Automatyczne przewijanie",
        description: "Transkrypcja podąża za audio, bieżący akapit jest zawsze widoczny.",
      },
      continuousPlayback: {
        title: "Ciągłe odtwarzanie",
        description:
          "Wykłady odtwarzają się jeden po drugim — gdy jeden się kończy, automatycznie zaczyna się następny, nawet przy zablokowanym ekranie.",
      },
      shareTranscript: {
        title: "Udostępnianie i eksport",
        description:
          "Udostępnij wykład jako PDF lub transkrypcję tekstową, albo udostępnij audio — komukolwiek.",
      },
      notesStudio: {
        title: "Studio notatek",
        description:
          "Zamień swoje notatki z wykładów w krótkie filmy i podziel się nimi z przyjaciółmi.",
      },
      trackInfo: {
        title: "Układ informacji o wykładzie",
        description:
          "Wybierz, który szczegół — werset, autor, miejsce, data — znajdzie się na widocznej górnej linii pod tytułem wykładu, a które pokażą się w linii poniżej.",
      },
    },
    periods: {
      P1M: "miesiąc",
      P3M: "3 miesiące",
      P6M: "6 miesięcy",
      P1Y: "rok",
    },
    plans: {
      $rc_monthly: "Miesięczna",
      $rc_three_month: "Kwartalna",
      $rc_six_month: "Półroczna",
      $rc_annual: "Roczna",
    },
    legal: {
      privacy: "Polityka prywatności",
      terms: "Warunki użytkowania",
    },
  },

  help: {
    open: {
      title: "Otwórz pomoc",
      description: "Objaśnienie wskaźników, ustawień i funkcji",
    },
    privacyPolicy: {
      title: "Polityka prywatności",
      description: "Co zbieramy, podmioty przetwarzające, usuwanie konta",
    },
  },

  /** Root font-size multiplier. The only way to enlarge a transcript or a
   *  verse on iOS, where the WebView honours neither pinch-zoom nor
   *  Dynamic Type. The chosen percentage IS the row subtitle, so there is
   *  no per-step copy to translate. */
  textSize: {
    title: "Rozmiar tekstu",
  },

  appLanguage: {
    title: "Język",
    description: "Język interfejsu",
    loadFailedToast: "Nie udało się wczytać tego języka. Spróbuj ponownie.",
  },

  chatLanguage: {
    title: "Język czatu",
    description: "Język, w którym odpowiada Sadhu.",
  },

  chatTranslateCitations: {
    title: "Tłumacz cytaty",
    description: "Tłumacz cytaty na język czatu.",
  },

  syncChats: {
    title: "Synchronizuj czaty",
    description: "Zachowaj rozmowy Ask Sadhu zsynchronizowane na wszystkich urządzeniach.",
  },

  downloadLimit: {
    title: "Limit pobierania",
    unlimited: "Bez limitu",
    usage: "{used} z {limit}",
    usageUnlimited: "Pobrano {used}",
  },

  smartLibrary: {
    title: "Inteligentna biblioteka",
    description: "Miej świeże wykłady pod ręką i porządkuj je po wysłuchaniu",
    enable: "Włącz",
    hint: "Aplikacja utrzymuje zapas niewysłuchanych wykładów i automatycznie usuwa te ukończone. Użyj filtra, aby wybrać, co ma trafiać do kolejki.",
    sections: {
      filter: "Co pobierać",
      target: "Długość kolejki",
      archive: "Archiwizuj po wysłuchaniu",
    },
    filter: {
      label: "Filtr",
      none: "Wszystkie wykłady",
    },
    target: {
      off: "Wyłączone",
      "30m": "30 minut",
      "1h": "1 godzina",
      "2h": "2 godziny",
      "3h": "3 godziny",
      "5h": "5 godzin",
      "8h": "8 godzin",
      "10h": "10 godzin",
    },
    archive: {
      off: "Nigdy",
      immediate: "Natychmiast",
      _8h: "Po 8 godzinach",
      _1d: "Po 1 dniu",
      _2d: "Po 2 dniach",
      _3d: "Po 3 dniach",
    },
    subtitleOff: "Automatyczne dodawanie wykładów i porządkowanie po wysłuchaniu",
    subtitleArchivePrefix: "archiwum",
  },

  preferredServer: {
    title: "Preferowany serwer",
  },

  trackInfo: {
    label: "Informacje o wykładzie",
    description: "Skonfiguruj wygląd listy wykładów",
    title: "Informacje o wykładzie",
    top: "Górna linia",
    topField: "Pole",
    bottom: "Dolna linia",
    none: "Nic",
    fields: {
      reference: "Werset",
      author: "Autor",
      location: "Miejsce",
      date: "Data",
      duration: "Długość",
    },
    preview: {
      title: "Happiness Beyond The Senses",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombaj",
      date: "21 kwi 1974",
      duration: "47m",
    },
  },
  player: {
    showProgress: {
      title: "Postęp odtwarzania",
      description: "Pokaż postęp wokół przycisku odtwarzania",
    },
    autoPlayNext: {
      title: "Autoodtwarzanie",
      description: "Gdy wykład się kończy, rozpocznij następny z playlisty",
    },
  },
  notes: {
    showPlayer: {
      title: "Odtwarzacz na stronie notatek",
      description: "Pokaż wbudowany odtwarzacz audio obok każdego cytatu",
    },
  },
  activityTracker: {
    show: {
      title: "Śledzenie aktywności",
      description: "Pokaż mapę cieplną słuchania na ekranie głównym",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Podświetlaj zdanie",
      description: "Podążaj za bieżącym zdaniem w transkrypcji",
    },
    autoScroll: {
      title: "Automatyczne przewijanie",
      description: "Podążaj za bieżącym akapitem podczas odtwarzania",
    },
    showAutomatically: {
      title: "Otwieraj transkrypcję automatycznie",
      description: "Otwórz transkrypcję podczas odtwarzania wykładu",
    },
  },

  contacts: {
    studio: {
      title: "Jiva Studio",
      description: "Odwiedź nasze studio i poznaj nasze inne aplikacje",
    },
    email: {
      title: "Napisz do nas e-mail",
      description: "Masz pytania lub sugestie?",
      emailSubject: "Prośba o pomoc",
      emailIntro: "Opisz swoje pytanie lub problem nad tą linią.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Powiadomienia",
      description: "Będziesz otrzymywać powiadomienia.",
    },
    daily: {
      title: "Godzina przypomnienia",
      description: "Godzina, o której będą wysyłane powiadomienia.",
    },
  },

  data: {
    export: {
      title: "Eksportuj dane użytkownika",
      description: "Zapisz playlistę, notatki i postępy do pliku",
      error: "Eksport nie powiódł się",
    },
    import: {
      title: "Importuj dane użytkownika",
      description: "Zastąp bieżące dane wcześniej wyeksportowanym plikiem",
      error: "Import nie powiódł się",
      confirm: {
        header: "Zastąpić wszystkie bieżące dane?",
        message:
          "Twoja bieżąca playlista, notatki, pobrania i postępy słuchania zostaną zastąpione zaimportowanym plikiem. Tego nie można cofnąć.",
        ok: "Zastąp",
        cancel: "Anuluj",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Wyświetl dzienniki",
      description: "Dziennik zdarzeń aplikacji · {count} wpisów",
    },
    email: {
      title: "Wyślij diagnostykę",
      description: "Wyślij logi i stan systemu do wsparcia",
      emailSubject: "Raport diagnostyczny",
      emailIntro: "Opisz swoje pytanie lub problem nad tą linią.",
    },
  },

  logs: {
    title: "Dzienniki",
    close: "Zamknij",
    copy: "Kopiuj",
    copied: "Skopiowano dzienniki",
    clear: "Wyczyść",
    count: "{count} wpisów",
    empty: "Brak dzienników",
  },

  danger: {
    clearCache: {
      title: "Wyczyść pamięć podręczną",
      description: "Usuwa wszystkie pobrane audio i transkrypcje",
    },
  },

  appVersion: "Wersja aplikacji",
  contentDatabase: "Baza treści",
  activeServer: "Aktywny CDN",
}
