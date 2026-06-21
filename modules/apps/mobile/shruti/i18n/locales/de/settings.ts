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
    signedIn: "Du bist angemeldet",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Dein Fortschritt ist sicher",
    signOut: "Abmelden",
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
    unavailable: "In-App-Käufe sind auf diesem Gerät nicht verfügbar.",
    manage: "Abonnement verwalten",
    restore: "Wiederherstellen",
    restored: "Dein Abonnement wurde erfolgreich wiederhergestellt!",
    error: "Bei der Aktion ist ein Fehler aufgetreten. Bitte versuche es erneut.",
    noSubscriptionFound:
      "Kein aktives Abonnement gefunden. Bitte abonniere, um Zugang zu den Premium-Funktionen zu erhalten.",
    cantPay: "Ich kann nicht bezahlen",
    cantPayEmailSubject: "Ich kann nicht bezahlen",
    cantPayEmailIntro: "Ich kann nicht bezahlen.",
    thanks:
      "Danke für dein Abonnement und deine Unterstützung 🙏 Möge dein Herz von Glück erfüllt sein und dich jeder Tag der Wahrheit näherbringen. Wir freuen uns, dass du auf diesem Weg bei uns bist.",
    benefits: {
      intro:
        "Wir entwickeln neue Funktionen und Verbesserungen. Deine Unterstützung hilft uns, die Entwicklung fortzusetzen und das Produkt besser zu machen.",
      benefit0: {
        title: "Neue Vorträge",
        description: "Dein Abonnement hilft uns, weiterhin neue Vorträge hinzuzufügen.",
      },
      benefit1: {
        title: "Lesezeichen",
        description:
          "Speichere wichtige Momente aus Text und Audio von Vorträgen, um später darauf zurückzukommen oder sie mit Freunden zu teilen.",
      },
      benefit2: {
        title: "Intelligente Bibliothek",
        description:
          "Die App hält frische Vorträge auf deinem Gerät bereit und entfernt automatisch die zu Ende gehörten.",
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
        description:
          "Durchsucht Vorträge, Audio und Bücher, findet Ślokas, erstellt PDFs und hilft dir, die Lehren zu verstehen. Mit einem Abonnement gibt es ein größeres tägliches Kontingent.",
      },
      autoScroll: {
        title: "Automatisches Scrollen",
        description:
          "Das Transkript folgt der Audiowiedergabe, sodass der aktuelle Absatz immer im Blick ist.",
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
  },

  chatLanguage: {
    title: "Chat-Sprache",
    description: "Sprache, in der Sadhu antwortet.",
  },

  chatTranslateCitations: {
    title: "Zitate übersetzen",
    description: "Zitate in die Chat-Sprache übersetzen.",
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

  dailyWisdom: {
    title: "Tägliche Weisheit",
    subtitleOn: "An · {count} Themen",
    subtitleOff: "Aus · nur eine Erinnerung",
    hint: "Wähle Themen, zu denen du täglich einen kurzen Gedanken möchtest — wir senden zur Erinnerungszeit ein abspielbares Fragment in deinen Chat. Ohne Auswahl bekommst du nur die Erinnerung.",
    empty: "Noch keine Themen mit täglicher Weisheit.",
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
