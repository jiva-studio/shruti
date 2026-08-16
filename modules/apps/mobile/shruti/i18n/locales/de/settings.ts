export default {
  groups: {
    subscription: "Abonnement",
    account: "Konto",
    appearance: "Darstellung",
    library: "Bibliothek",
    chat: "Frag Sadhu",
    contacts: "Kontakt",
    status: "Status",
    sadhana: "Sādhana",
    data: "Daten",
    help: "Hilfe",
    debug: "Debug",
    danger: "Gefahrenzone",
    about: "Über die App",
  },
  libraryLanguages: {
    title: "Vortragssprachen",
    description: "Vorträge in diesen Sprachen in Suche, Themen und Empfehlungen anzeigen.",
  },

  account: {
    signInCta: {
      title: "Anmelden",
      description: "Behalte deinen Fortschritt",
    },
    signInWithGoogle: "Mit Google fortfahren",
    signInWithApple: "Mit Apple fortfahren",
    signInWithEmail: "Mit E-Mail fortfahren",
    email: {
      title: "Mit E-Mail anmelden",
      emailStep: "Wir schicken dir einen Einmalcode per E-Mail — ganz ohne Passwort.",
      emailLabel: "E-Mail",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "Code senden",
      codeStep: "Gib den 6-stelligen Code ein, den wir an {email} geschickt haben.",
      codeLabel: "Code",
      codePlaceholder: "6-stelliger Code",
      verify: "Anmelden",
      resend: "Code erneut senden",
      resendIn: "Erneut senden in {seconds} s",
      changeEmail: "E-Mail ändern",
      errors: {
        invalidEmail: "Bitte gib eine gültige E-Mail-Adresse ein.",
        invalidCode: "Dieser Code ist ungültig oder abgelaufen.",
        throttled: "Bitte warte einen Moment, bevor du einen neuen Code anforderst.",
        disabled: "Die Anmeldung per E-Mail ist derzeit nicht verfügbar.",
        network: "Keine Verbindung. Prüfe dein Internet und versuche es erneut.",
        server: "Auf unserer Seite ist etwas schiefgelaufen. Bitte versuche es gleich noch einmal.",
        generic: "Etwas ist schiefgelaufen. Bitte versuche es erneut.",
      },
    },
    signedIn: "Du bist angemeldet",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Dein Fortschritt ist sicher",
    signOut: "Abmelden",
    signOutWipeToast:
      "Abgemeldet. Deine Notizen und Chats bleiben in deinem Konto und kehren bei der nächsten Anmeldung zurück. Heruntergeladene Vorträge wurden von diesem Gerät gelöscht und müssen erneut heruntergeladen werden.",
    signOutWipeToastChatLocal:
      "Abgemeldet. Deine Notizen bleiben in deinem Konto und kehren bei der nächsten Anmeldung zurück. Die Chat-Synchronisierung war aus, deshalb lagen deine Chats nur auf diesem Gerät und wurden gelöscht. Heruntergeladene Vorträge wurden ebenfalls gelöscht und müssen erneut heruntergeladen werden.",
    signOutWipeUnsentSuffix:
      "Die letzten Änderungen konnten vor dem Abmelden nicht hochgeladen werden und sind verloren.",
    deleteAccount: {
      title: "Konto löschen",
      confirmWipe: "Konto löschen und Daten entfernen",
      confirmKeep: "Konto löschen, meine Daten behalten",
      errorToast: "Konto konnte nicht gelöscht werden. Bitte versuche es erneut.",
      alreadyDeletedToast: "Dein Konto ist bereits gelöscht.",
      rateLimitedToast: "Bitte warte einen Moment, bevor du es erneut versuchst.",
      networkErrorToast: "Keine Verbindung. Prüfe dein Internet und versuche es erneut.",
      serverErrorToast:
        "Auf unserer Seite ist etwas schiefgelaufen. Bitte versuche es gleich erneut.",
    },
  },

  subscription: {
    title: "Abonnement",
    description: "Abonnement verwalten",
    subscriptionIsActive: "Abonnement ist aktiv",
    tapToManage: "Tippen zum Ansehen oder Verwalten",
    choose: "Unterstütze „Shruti“",
    subscribe: "Abonnieren",
    trialBadge: "{days} Tage kostenlos",
    trialThenPrice: "danach {price} / {period}",
    startFreeTrial: "Kostenlos testen",
    trialDisclaimer:
      "Jederzeit kündbar. Nach dem Testzeitraum verlängert sich das Abo automatisch.",
    disclaimer: "Jederzeit kündbar. Das Abo verlängert sich automatisch.",
    subscribed: "Abonnement abgeschlossen",
    loading: "Abo-Optionen werden geladen…",
    unavailable: "In-App-Käufe sind auf diesem Gerät nicht verfügbar.",
    manage: "Abonnement verwalten",
    restore: "Wiederherstellen",
    restored: "Dein Abonnement wurde erfolgreich wiederhergestellt!",
    error: "Bei der Aktion ist ein Fehler aufgetreten. Bitte versuche es erneut.",
    noSubscriptionFound:
      "Kein aktives Abonnement gefunden. Bitte abonniere, um Zugang zu den Premium-Funktionen zu erhalten.",
    thanks:
      "Danke für dein Abonnement und deine Unterstützung 🙏 Möge dein Herz von Glück erfüllt sein und dich jeder Tag der Wahrheit näherbringen. Wir freuen uns, dass du auf diesem Weg bei uns bist.",
    benefits: {
      progress: {
        title: "Verfolge deinen Fortschritt",
        description: "Verfolge deine Hör-Serie und mach dort weiter, wo du aufgehört hast.",
      },
      andMore: {
        title: "Und vieles mehr",
        description: "Fortlaufende Wiedergabe, Teilen, das Notizen-Studio und vieles mehr.",
      },
      intro:
        "Wir entwickeln neue Funktionen und Verbesserungen. Deine Unterstützung hilft uns, die Entwicklung fortzusetzen und das Produkt besser zu machen.",
      benefit0: {
        title: "Neue Vorträge",
        description: "Dein Abonnement hilft uns, neue Vorträge hinzuzufügen.",
      },
      benefit1: {
        title: "Lesezeichen",
        description: "Speichere wichtige Momente eines Vortrags zum Wiederfinden oder Teilen.",
      },
      benefit2: {
        title: "Intelligente Bibliothek",
        description: "Hält frische Vorträge auf dem Gerät und entfernt gehörte automatisch.",
      },
      benefit3: {
        title: "Seminare und Kurse",
        description:
          "Füge Seminare und Kurse zu deiner Playlist hinzu, um sie in einer passenden Reihenfolge zu hören.",
      },
      benefit4: {
        title: "Dynamische Sammlungen",
        description:
          "Erstelle Sammlungen für Vorträge, die sich anhand festgelegter Kriterien automatisch aktualisieren.",
      },
      sakha: {
        title: "Frag Sadhu",
        description: "Durchsucht Vorträge, Audio und Bücher und erklärt die Lehren.",
      },
      autoScroll: {
        title: "Automatisches Scrollen",
        description: "Das Transkript folgt dem Audio, der aktuelle Absatz bleibt im Blick.",
      },
      continuousPlayback: {
        title: "Durchgehende Wiedergabe",
        description:
          "Vorträge laufen nacheinander — wenn einer endet, beginnt der nächste automatisch, auch bei gesperrtem Bildschirm.",
      },
      shareTranscript: {
        title: "Teilen & Export",
        description:
          "Teile einen Vortrag als PDF oder Text-Transkript, oder teile das Audio — mit jedem.",
      },
      notesStudio: {
        title: "Notiz-Studio",
        description:
          "Verwandle deine Notizen aus Vorträgen in kurze Videos und teile sie mit Freunden.",
      },
      trackInfo: {
        title: "Track-Info-Layout",
        description:
          "Wähle, welches Detail — Quellenangabe, Autor, Ort, Datum — in der prominenten oberen Zeile unter jedem Vortragstitel steht und welche in der Zeile darunter erscheinen.",
      },
    },
    periods: {
      P1M: "Monat",
      P3M: "3 Monate",
      P6M: "6 Monate",
      P1Y: "Jahr",
    },
    plans: {
      $rc_monthly: "Monatlich",
      $rc_three_month: "Vierteljährlich",
      $rc_six_month: "Halbjährlich",
      $rc_annual: "Jährlich",
    },
    legal: {
      privacy: "Datenschutzrichtlinie",
      terms: "Nutzungsbedingungen",
    },
  },

  help: {
    open: {
      title: "Hilfe öffnen",
      description: "Indikatoren, Einstellungen und Funktionen erklärt",
    },
    privacyPolicy: {
      title: "Datenschutzrichtlinie",
      description: "Was wir erheben, Unterauftragsverarbeiter, Kontolöschung",
    },
  },

  appLanguage: {
    title: "Sprache",
    description: "Sprache der Oberfläche",
    loadFailedToast: "Diese Sprache konnte nicht geladen werden. Bitte erneut versuchen.",
  },

  chatLanguage: {
    title: "Chat-Sprache",
    description: "Sprache, in der Sadhu antwortet.",
  },

  chatTranslateCitations: {
    title: "Zitate übersetzen",
    description: "Zitate in die Chat-Sprache übersetzen.",
  },

  syncChats: {
    title: "Chats synchronisieren",
    description: "Halte deine Ask-Sadhu-Unterhaltungen auf all deinen Geräten synchron.",
  },

  downloadLimit: {
    title: "Download-Limit",
    unlimited: "Ohne Limit",
    usage: "{used} von {limit}",
    usageUnlimited: "{used} geladen",
  },

  smartLibrary: {
    title: "Intelligente Bibliothek",
    description: "Frische Vorträge bereithalten und nach dem Hören aufräumen",
    enable: "Aktivieren",
    hint: "Die App hält einen Vorrat an ungehörten Vorträgen bereit und entfernt automatisch die zu Ende gehörten. Was heruntergeladen wird, legst du über den Filter fest.",
    sections: {
      filter: "Was heruntergeladen wird",
      target: "Länge der Warteschlange",
      archive: "Nach dem Hören archivieren",
    },
    filter: {
      label: "Filter",
      none: "Alle Vorträge",
    },
    target: {
      off: "Aus",
      "30m": "30 Minuten",
      "1h": "1 Stunde",
      "2h": "2 Stunden",
      "3h": "3 Stunden",
      "5h": "5 Stunden",
      "8h": "8 Stunden",
      "10h": "10 Stunden",
    },
    archive: {
      off: "Nie",
      immediate: "Sofort",
      _8h: "Nach 8 Stunden",
      _1d: "Nach 1 Tag",
      _2d: "Nach 2 Tagen",
      _3d: "Nach 3 Tagen",
    },
    subtitleOff: "Vorträge automatisch aktualisieren und nach dem Hören aufräumen",
    subtitleArchivePrefix: "Archiv",
  },

  preferredServer: {
    title: "Bevorzugter Server",
  },

  trackInfo: {
    label: "Track-Info",
    description: "Anzeige der Trackliste anpassen",
    title: "Track-Info",
    top: "Obere Zeile",
    topField: "Feld",
    bottom: "Untere Zeile",
    none: "Nichts",
    fields: {
      reference: "Quellenangabe",
      author: "Autor",
      location: "Ort",
      date: "Datum",
      duration: "Dauer",
    },
    preview: {
      title: "Happiness Beyond The Senses",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombay",
      date: "21. Apr. 1974",
      duration: "47Min",
    },
  },
  player: {
    showProgress: {
      title: "Player-Fortschritt",
      description: "Fortschritt rund um die Wiedergabetaste anzeigen",
    },
    autoPlayNext: {
      title: "Automatische Wiedergabe",
      description: "Wenn ein Vortrag endet, den nächsten aus deiner Playlist starten",
    },
  },
  notes: {
    showPlayer: {
      title: "Player auf der Notizenseite",
      description: "Einen eingebetteten Audioplayer neben jedem Zitat anzeigen",
    },
  },
  activityTracker: {
    show: {
      title: "Aktivitätstracker",
      description: "Hör-Heatmap auf dem Startbildschirm anzeigen",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Satz hervorheben",
      description: "Dem aktuellen Satz im Transkript folgen",
    },
    autoScroll: {
      title: "Automatisches Scrollen",
      description: "Dem aktuellen Absatz während der Audiowiedergabe folgen",
    },
    showAutomatically: {
      title: "Transkript automatisch öffnen",
      description: "Transkript beim Abspielen eines Vortrags öffnen",
    },
  },

  contacts: {
    studio: {
      title: "Jiva Studio",
      description: "Besuche unser Studio und entdecke unsere anderen Apps",
    },
    email: {
      title: "Schreib uns eine E-Mail",
      description: "Hast du Fragen oder Vorschläge?",
      emailSubject: "Support-Anfrage",
      emailIntro: "Bitte beschreibe deine Frage oder dein Problem oberhalb dieser Zeile.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Benachrichtigungen",
      description: "Du erhältst Benachrichtigungen.",
    },
    daily: {
      title: "Erinnerungszeit",
      description: "Die Zeit, zu der Benachrichtigungen gesendet werden.",
    },
  },

  data: {
    export: {
      title: "Nutzerdaten exportieren",
      description: "Playlist, Notizen und Fortschritt in einer Datei speichern",
      error: "Export fehlgeschlagen",
    },
    import: {
      title: "Nutzerdaten importieren",
      description: "Aktuelle Daten durch eine zuvor exportierte Datei ersetzen",
      error: "Import fehlgeschlagen",
      confirm: {
        header: "Alle aktuellen Daten ersetzen?",
        message:
          "Deine aktuelle Playlist, Notizen, Downloads und dein Hörfortschritt werden durch die importierte Datei ersetzt. Das kann nicht rückgängig gemacht werden.",
        ok: "Ersetzen",
        cancel: "Abbrechen",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Logs ansehen",
      description: "In-App-Ereignisprotokoll · {count} Einträge",
    },
    email: {
      title: "Diagnose senden",
      description: "Logs und Systemstatus an den Support senden",
      emailSubject: "Diagnosebericht",
      emailIntro: "Bitte beschreibe deine Frage oder dein Problem oberhalb dieser Zeile.",
    },
  },

  logs: {
    title: "Logs",
    close: "Schließen",
    copy: "Kopieren",
    copied: "Logs kopiert",
    clear: "Löschen",
    count: "{count} Einträge",
    empty: "Noch keine Logs",
  },

  danger: {
    clearCache: {
      title: "Cache leeren",
      description: "Entfernt alle heruntergeladenen Audios und Transkripte",
    },
  },

  appVersion: "App-Version",
  contentDatabase: "Inhaltsdatenbank",
  activeServer: "Aktives CDN",
}
