export default {
  groups: {
    subscription: "Abbonamento",
    account: "Account",
    appearance: "Aspetto",
    library: "Biblioteca",
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
  libraryLanguages: {
    title: "Lingue delle lezioni",
    description: "Mostra le lezioni in queste lingue in ricerca, temi e raccomandazioni.",
  },

  account: {
    signInCta: {
      title: "Accedi",
      description: "Conserva i tuoi progressi",
    },
    signInWithGoogle: "Continua con Google",
    signInWithApple: "Continua con Apple",
    signInWithEmail: "Continua con l'email",
    email: {
      title: "Accedi con l'email",
      emailStep: "Ti invieremo un codice monouso via email, senza password.",
      emailLabel: "Email",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "Invia codice",
      codeStep: "Inserisci il codice di 6 cifre che abbiamo inviato a {email}.",
      codeLabel: "Codice",
      codePlaceholder: "Codice di 6 cifre",
      verify: "Accedi",
      resend: "Invia di nuovo il codice",
      resendIn: "Reinvio tra {seconds} s",
      changeEmail: "Cambia email",
      errors: {
        invalidEmail: "Inserisci un indirizzo email valido.",
        invalidCode: "Il codice non è valido o è scaduto.",
        throttled: "Attendi un momento prima di richiedere un altro codice.",
        disabled: "L'accesso via email non è disponibile al momento.",
        network: "Nessuna connessione. Controlla internet e riprova.",
        server: "Qualcosa è andato storto da parte nostra. Riprova tra un istante.",
        generic: "Qualcosa è andato storto. Riprova.",
      },
    },
    signedIn: "Hai effettuato l'accesso",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "I tuoi progressi sono al sicuro",
    signOut: "Esci",
    signOutWipeToast:
      "Disconnesso. Le tue note e conversazioni restano nel tuo account e torneranno al prossimo accesso. Le lezioni scaricate sono state eliminate da questo dispositivo e dovranno essere scaricate di nuovo.",
    signOutWipeToastChatLocal:
      "Disconnesso. Le tue note restano nel tuo account e torneranno al prossimo accesso. La sincronizzazione delle conversazioni era disattivata: erano solo su questo dispositivo e sono state eliminate. Anche le lezioni scaricate sono state eliminate e dovranno essere scaricate di nuovo.",
    signOutWipeUnsentSuffix:
      "Le ultime modifiche non sono state caricate prima della disconnessione e sono andate perse.",
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
    disclaimer: "Disdici quando vuoi. L'abbonamento si rinnova automaticamente.",
    subscribed: "Abbonamento completato",
    loading: "Caricamento delle opzioni di abbonamento…",
    unavailable: "Gli acquisti in-app non sono disponibili su questo dispositivo.",
    unconfirmed:
      "Non è stato possibile confermare il tuo abbonamento. Se ne hai già uno, tocca “Ripristina”.",
    manage: "Gestisci abbonamento",
    restore: "Ripristina",
    restored: "Il tuo abbonamento è stato ripristinato con successo!",
    error: "Si è verificato un errore durante l'operazione. Riprova.",
    noSubscriptionFound:
      "Nessun abbonamento attivo trovato. Abbonati per accedere alle funzioni premium.",
    thanks:
      "Grazie per il tuo abbonamento e il tuo sostegno 🙏 Che il tuo cuore si riempia di felicità e che ogni giorno ti avvicini alla Verità. Siamo felici che tu sia con noi su questo cammino.",
    benefits: {
      progress: {
        title: "Monitora i tuoi progressi",
        description: "Segui la tua serie di ascolti e riprendi da dove avevi lasciato.",
      },
      andMore: {
        title: "E molto altro",
        description: "Riproduzione continua, condivisione, lo studio note e molto altro.",
      },
      intro:
        "Stiamo realizzando nuove funzioni e miglioramenti. Il tuo sostegno ci aiuta a continuare lo sviluppo e a rendere il prodotto migliore.",
      benefit0: {
        title: "Nuove lezioni",
        description: "Il tuo abbonamento ci aiuta ad aggiungere nuove lezioni.",
      },
      benefit1: {
        title: "Segnalibri",
        description: "Salva i momenti chiave di una lezione per rivederli o condividerli.",
      },
      benefit2: {
        title: "Biblioteca intelligente",
        description: "Tiene nuove lezioni sul dispositivo e rimuove quelle terminate.",
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
        description: "Cerca tra lezioni, audio e libri e spiega gli insegnamenti.",
      },
      autoScroll: {
        title: "Scorrimento automatico",
        description: "La trascrizione segue l'audio, il paragrafo corrente resta in vista.",
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

  /** Root font-size multiplier. The only way to enlarge a transcript or a
   *  verse on iOS, where the WebView honours neither pinch-zoom nor
   *  Dynamic Type. The chosen percentage IS the row subtitle, so there is
   *  no per-step copy to translate. */
  textSize: {
    title: "Dimensione del testo",
  },

  appLanguage: {
    title: "Lingua",
    description: "Lingua dell'interfaccia",
    loadFailedToast: "Impossibile caricare questa lingua. Riprova.",
  },

  chatLanguage: {
    title: "Lingua della chat",
    description: "Lingua in cui Sadhu risponde.",
  },

  chatTranslateCitations: {
    title: "Traduci le citazioni",
    description: "Traduci le citazioni nella lingua della chat.",
  },

  syncChats: {
    title: "Sincronizza le chat",
    description:
      "Mantieni le tue conversazioni di Ask Sadhu sincronizzate su tutti i tuoi dispositivi.",
  },

  downloadLimit: {
    title: "Limite di download",
    unlimited: "Nessun limite",
    usage: "{used} di {limit}",
    usageUnlimited: "{used} scaricati",
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
      off: "Mai",
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
    studio: {
      title: "Jiva Studio",
      description: "Visita il nostro studio e scopri le nostre altre app",
    },
    email: {
      title: "Scrivici un'email",
      description: "Hai domande o suggerimenti?",
      emailSubject: "Richiesta di assistenza",
      emailIntro: "Descrivi la tua domanda o il problema sopra questa riga.",
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
    email: {
      title: "Invia diagnostica",
      description: "Invia i log e lo stato del sistema all'assistenza",
      emailSubject: "Rapporto di diagnostica",
      emailIntro: "Descrivi la tua domanda o il problema sopra questa riga.",
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
