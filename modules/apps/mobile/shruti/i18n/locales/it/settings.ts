export default {
  groups: {
    subscription: "Abbonamento",
    account: "Account",
    appearance: "Aspetto",
    chat: "Chiedi a Sadhu",
    contacts: "Contattaci",
    status: "Stato",
    sadhana: "Sadhana",
    data: "Dati",
    help: "Aiuto",
    debug: "Debug",
    danger: "Zona pericolosa",
    about: "Informazioni",
  },

  account: {
    signInCta: {
      title: "Accedi",
      description: "Conserva i tuoi progressi",
    },
    signInWithGoogle: "Continua con Google",
    signInWithApple: "Continua con Apple",
    signedIn: "Hai effettuato l'accesso",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "I tuoi progressi sono al sicuro",
    signOut: "Esci",
    deleteAccount: {
      title: "Elimina account",
      confirmWipe: "Elimina account e cancella i dati",
      confirmKeep: "Elimina account, conserva i dati",
      errorToast: "Impossibile eliminare l'account. Riprova.",
      alreadyDeletedToast: "Il tuo account è già stato eliminato.",
      rateLimitedToast: "Attendi un momento prima di riprovare.",
      networkErrorToast: "Nessuna connessione. Controlla internet e riprova.",
      serverErrorToast: "Qualcosa è andato storto da parte nostra. Riprova tra un istante.",
    },
  },

  subscription: {
    title: "Abbonamento",
    description: "Gestione dell'abbonamento",
    subscriptionIsActive: "L'abbonamento è attivo",
    tapToManage: "Tocca per visualizzare o gestire",
    choose: 'Sostieni "Shruti"',
    subscribe: "Abbonati",
    trialBadge: "{days} giorni gratis",
    trialThenPrice: "poi {price} / {period}",
    startFreeTrial: "Inizia la prova gratuita",
    trialDisclaimer:
      "Disdici quando vuoi. Al termine della prova, l'abbonamento si rinnova automaticamente.",
    subscribed: "Abbonamento completato",
    manage: "Gestisci abbonamento",
    restore: "Ripristina",
    restored: "Il tuo abbonamento è stato ripristinato con successo!",
    error: "Si è verificato un errore durante l'operazione. Riprova.",
    noSubscriptionFound:
      "Nessun abbonamento attivo trovato. Abbonati per accedere alle funzioni premium.",
    cantPay: "Non riesco a pagare",
    cantPayEmailSubject: "Non riesco a pagare",
    cantPayEmailIntro: "Non riesco a pagare.",
    thanks:
      "Grazie per il tuo abbonamento e il tuo sostegno 🙏 Che il tuo cuore si riempia di felicità e che ogni giorno ti avvicini alla Verità. Siamo felici che tu sia con noi su questo cammino.",
    benefits: {
      intro:
        "Stiamo realizzando nuove funzioni e miglioramenti. Il tuo sostegno ci aiuta a continuare lo sviluppo e a rendere il prodotto migliore.",
      benefit0: {
        title: "Nuove lezioni",
        description: "Il tuo abbonamento ci aiuta a continuare ad aggiungere nuove lezioni.",
      },
      benefit1: {
        title: "Segnalibri",
        description:
          "Salva i momenti importanti dal testo e dall'audio delle lezioni per rivederli più tardi o condividerli con gli amici.",
      },
      benefit2: {
        title: "Biblioteca intelligente",
        description:
          "L'app tiene nuove lezioni sul tuo dispositivo e rimuove automaticamente quelle terminate.",
      },
      benefit3: {
        title: "Seminari e corsi",
        description:
          "Aggiungi seminari e corsi alla tua playlist per ascoltarli in un ordine comodo.",
      },
      benefit4: {
        title: "Raccolte dinamiche",
        description:
          "Crea raccolte di lezioni che si aggiornano automaticamente in base ai criteri scelti.",
      },
      sakha: {
        title: "Chiedi a Sadhu",
        description:
          "Cerca nelle lezioni, nell'audio e nei libri, trova le shloka, genera PDF e ti aiuta a comprendere gli insegnamenti. Con l'abbonamento il limite giornaliero è più alto.",
      },
      autoScroll: {
        title: "Scorrimento automatico",
        description:
          "La trascrizione segue l'audio in riproduzione, così il paragrafo corrente è sempre in vista.",
      },
      continuousPlayback: {
        title: "Riproduzione continua",
        description:
          "Le lezioni si susseguono — quando una finisce inizia automaticamente la successiva, anche a schermo bloccato.",
      },
      shareTranscript: {
        title: "Condividi ed esporta",
        description:
          "Condividi una lezione come PDF o trascrizione testuale, oppure condividi l'audio — con chiunque.",
      },
      notesStudio: {
        title: "Studio delle note",
        description:
          "Trasforma le tue note dalle lezioni in brevi video e condividili con gli amici.",
      },
      trackInfo: {
        title: "Layout informazioni traccia",
        description:
          "Scegli quale dettaglio — riferimento, autore, luogo, data — compare sulla riga superiore in evidenza sotto il titolo di ogni lezione, e quali nella riga sottostante.",
      },
    },
    periods: {
      P1M: "mese",
      P3M: "3 mesi",
      P6M: "6 mesi",
      P1Y: "anno",
    },
    plans: {
      $rc_monthly: "Mensile",
      $rc_three_month: "Trimestrale",
      $rc_six_month: "Semestrale",
      $rc_annual: "Annuale",
    },
    legal: {
      privacy: "Informativa sulla privacy",
      terms: "Termini di utilizzo",
    },
  },

  help: {
    open: {
      title: "Apri l'aiuto",
      description: "Indicatori, impostazioni e funzioni spiegati",
    },
    privacyPolicy: {
      title: "Informativa sulla privacy",
      description: "Cosa raccogliamo, sub-responsabili, eliminazione dell'account",
    },
  },

  appLanguage: {
    title: "Lingua",
    description: "Lingua dell'interfaccia",
  },

  chatLanguage: {
    title: "Lingua della chat",
    description: "Lingua in cui Sadhu risponde.",
  },

  chatTranslateCitations: {
    title: "Traduci le citazioni",
    description: "Traduci le citazioni nella lingua della chat.",
  },

  smartLibrary: {
    title: "Biblioteca intelligente",
    description: "Tieni pronte nuove lezioni e fai pulizia dopo l'ascolto",
    enable: "Attiva",
    hint: "L'app mantiene una riserva di lezioni non ascoltate e rimuove automaticamente quelle terminate. Usa il filtro per scegliere cosa mettere in coda.",
    sections: {
      filter: "Cosa scaricare",
      target: "Durata della coda",
      archive: "Archivia dopo l'ascolto",
    },
    filter: {
      label: "Filtro",
      none: "Tutte le lezioni",
    },
    target: {
      off: "Disattivato",
      "30m": "30 minuti",
      "1h": "1 ora",
      "2h": "2 ore",
      "3h": "3 ore",
      "5h": "5 ore",
      "8h": "8 ore",
      "10h": "10 ore",
    },
    archive: {
      immediate: "Subito",
      _8h: "Dopo 8 ore",
      _1d: "Dopo 1 giorno",
      _2d: "Dopo 2 giorni",
      _3d: "Dopo 3 giorni",
    },
    subtitleOff: "Aggiorna le lezioni in automatico e fa pulizia dopo l'ascolto",
    subtitleArchivePrefix: "archivio",
  },

  preferredServer: {
    title: "Server preferito",
  },

  trackInfo: {
    label: "Informazioni traccia",
    description: "Configura l'aspetto dell'elenco delle tracce",
    title: "Informazioni traccia",
    top: "Riga superiore",
    topField: "Campo",
    bottom: "Riga inferiore",
    none: "Niente",
    fields: {
      reference: "Riferimento",
      author: "Autore",
      location: "Luogo",
      date: "Data",
      duration: "Durata",
    },
    preview: {
      title: "Happiness Beyond The Senses",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombay",
      date: "21 apr 1974",
      duration: "47m",
    },
  },
  player: {
    showProgress: {
      title: "Progresso del player",
      description: "Mostra il progresso attorno al pulsante di riproduzione",
    },
    autoPlayNext: {
      title: "Riproduzione automatica",
      description: "Quando una lezione finisce, avvia la successiva nella tua playlist",
    },
  },
  notes: {
    showPlayer: {
      title: "Player nella pagina delle note",
      description: "Mostra un player audio integrato accanto a ogni citazione",
    },
  },
  activityTracker: {
    show: {
      title: "Tracker dell'attività",
      description: "Mostra la mappa di calore dell'ascolto nella schermata Home",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Evidenzia la frase",
      description: "Segui la frase corrente nella trascrizione",
    },
    autoScroll: {
      title: "Scorrimento automatico",
      description: "Segui il paragrafo corrente durante la riproduzione",
    },
    showAutomatically: {
      title: "Apri la trascrizione automaticamente",
      description: "Apri la trascrizione durante la riproduzione di una lezione",
    },
  },

  contacts: {
    email: {
      title: "Scrivici un'email",
      description: "Hai domande o suggerimenti?",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Notifiche",
      description: "Riceverai le notifiche.",
    },
    daily: {
      title: "Orario del promemoria",
      description: "L'ora in cui verranno inviate le notifiche.",
    },
  },

  data: {
    export: {
      title: "Esporta i dati utente",
      description: "Salva playlist, note e progressi in un file",
      error: "Esportazione non riuscita",
    },
    import: {
      title: "Importa i dati utente",
      description: "Sostituisci i dati attuali con un file esportato in precedenza",
      error: "Importazione non riuscita",
      confirm: {
        header: "Sostituire tutti i dati attuali?",
        message:
          "La playlist, le note, i download e i progressi di ascolto attuali verranno sostituiti dal file importato. L'azione non può essere annullata.",
        ok: "Sostituisci",
        cancel: "Annulla",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Visualizza i log",
      description: "Registro eventi in-app · {count} voci",
    },
  },

  logs: {
    title: "Log",
    close: "Chiudi",
    copy: "Copia",
    copied: "Log copiati",
    clear: "Cancella",
    count: "{count} voci",
    empty: "Ancora nessun log",
  },

  danger: {
    clearCache: {
      title: "Svuota la cache",
      description: "Rimuove tutti gli audio e le trascrizioni scaricati",
    },
  },

  appVersion: "Versione dell'app",
  contentDatabase: "Database dei contenuti",
  activeServer: "CDN attiva",
}
