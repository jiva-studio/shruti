export default {
  groups: {
    subscription: "Pretplata",
    account: "Nalog",
    appearance: "Izgled",
    library: "Biblioteka",
    chat: "Pitaj Sadhua",
    contacts: "Kontaktirajte nas",
    status: "Status",
    sadhana: "Sadhana",
    data: "Podaci",
    help: "Pomoć",
    debug: "Otklanjanje grešaka",
    danger: "Opasna zona",
    about: "O aplikaciji",
  },
  libraryLanguages: {
    title: "Jezici predavanja",
    description: "Prikaži predavanja na ovim jezicima u pretrazi, temama i preporukama.",
  },

  chatLanguage: {
    title: "Jezik ćaskanja",
    description: "Jezik na kojem Sadhu odgovara.",
  },

  chatTranslateCitations: {
    title: "Prevedi citate",
    description: "Prevedi citate na jezik ćaskanja.",
  },

  account: {
    signInCta: {
      title: "Prijavite se",
      description: "Sačuvajte svoj napredak",
    },
    signInWithGoogle: "Putem Google-a",
    signInWithApple: "Putem Apple-a",
    signedIn: "Prijavljeni ste",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Vaš napredak je bezbedan",
    signOut: "Odjavi se",
    deleteAccount: {
      title: "Obriši nalog",
      confirmWipe: "Obriši nalog i izbriši podatke",
      confirmKeep: "Obriši nalog, zadrži podatke",
      errorToast: "Nije moguće obrisati nalog. Pokušajte ponovo.",
      alreadyDeletedToast: "Vaš nalog je već obrisan.",
      rateLimitedToast: "Sačekajte malo pre nego što pokušate ponovo.",
      networkErrorToast: "Nema veze. Proverite internet i pokušajte ponovo.",
      serverErrorToast: "Nešto je pošlo po zlu na našoj strani. Pokušajte za trenutak.",
    },
  },

  subscription: {
    title: "Pretplata",
    description: "Upravljanje pretplatom",
    subscriptionIsActive: "Pretplata je aktivna",
    tapToManage: "Otvori i upravljaj",
    choose: "Podržite „Slušaj Sadhua“",
    subscribe: "Pretplati se",
    trialBadge: "{days} dana besplatno",
    trialThenPrice: "zatim {price} / {period}",
    startFreeTrial: "Započni besplatnu probu",
    trialDisclaimer: "Otkažite bilo kad. Posle probnog perioda pretplata se automatski obnavlja.",
    disclaimer: "Otkažite bilo kad. Pretplata se automatski obnavlja.",
    subscribed: "Pretplata je obavljena",
    unavailable: "Kupovine unutar aplikacije nisu dostupne na ovom uređaju.",
    manage: "Upravljanje pretplatom",
    restore: "Vrati",
    restored: "Vaša pretplata je uspešno vraćena!",
    error: "Došlo je do greške tokom operacije. Pokušajte ponovo.",
    noSubscriptionFound:
      "Aktivna pretplata nije pronađena. Pretplatite se da biste pristupili Pro funkcijama.",
    thanks:
      "Hvala vam na pretplati i podršci 🙏 Neka vam srce bude ispunjeno srećom, a svaki dan vas približi Istini. Drago nam je što ste sa nama na ovom putu.",
    benefits: {
      progress: {
        title: "Pratite svoj napredak",
        description: "Pratite svoj niz slušanja i nastavite gde ste stali.",
      },
      andMore: {
        title: "I još mnogo toga",
        description: "Neprekidna reprodukcija, deljenje, studio beleški i još mnogo toga.",
      },
      intro:
        "Uvodimo nove funkcije i poboljšanja. Vaša podrška nam pomaže da nastavimo razvoj i učinimo proizvod boljim.",
      benefit0: {
        title: "Nova predavanja",
        description: "Vaša pretplata nam pomaže da dodajemo nova predavanja.",
      },
      benefit1: {
        title: "Obeleživači",
        description: "Sačuvajte ključne trenutke predavanja da im se vratite ili ih podelite.",
      },
      benefit2: {
        title: "Pametna biblioteka",
        description: "Drži sveža predavanja na uređaju i automatski uklanja odslušana.",
      },
      benefit3: {
        title: "Seminari i kursevi",
        description: "Dodajte seminare i kurseve na listu numera da ih slušate povoljnim redom.",
      },
      benefit4: {
        title: "Dinamičke kolekcije",
        description:
          "Kreirajte kolekcije predavanja koje će se automatski ažurirati prema zadatim kriterijumima.",
      },
      sakha: {
        title: "Pitaj Sadhua",
        description: "Pretražuje predavanja, audio i knjige i objašnjava učenja.",
      },
      autoScroll: {
        title: "Automatsko skrolovanje",
        description: "Transkript prati audio, pa je trenutni pasus uvek pred očima.",
      },
      continuousPlayback: {
        title: "Neprekidna reprodukcija",
        description:
          "Predavanja idu jedno za drugim — kada se jedno završi, sledeće počinje automatski, čak i sa zaključanim ekranom.",
      },
      shareTranscript: {
        title: "Deli i izvezi",
        description:
          "Podelite predavanje kao PDF ili tekstualni transkript, ili podelite audio — sa bilo kim.",
      },
      notesStudio: {
        title: "Studio za beleške",
        description:
          "Pretvorite svoje beleške iz predavanja u kratke video snimke i podelite ih sa prijateljima.",
      },
      trackInfo: {
        title: "Raspored informacija o numeri",
        description:
          "Izaberite koji detalj — izvor, autor, lokacija, datum — stoji u istaknutom gornjem redu ispod naslova predavanja, a koji se prikazuju u redu ispod.",
      },
    },
    periods: {
      P1M: "mesec",
      P3M: "3 meseca",
      P6M: "6 meseci",
      P1Y: "godina",
    },
    plans: {
      $rc_monthly: "Mesečna",
      $rc_three_month: "Tromesečna",
      $rc_six_month: "Polugodišnja",
      $rc_annual: "Godišnja",
    },
    legal: {
      privacy: "Politika privatnosti",
      terms: "Uslovi korišćenja",
    },
  },

  help: {
    open: {
      title: "Otvori pomoć",
      description: "Objašnjeni indikatori, podešavanja i funkcije",
    },
    privacyPolicy: {
      title: "Politika privatnosti",
      description: "Šta prikupljamo, podizvođači, brisanje naloga",
    },
  },

  appLanguage: {
    title: "Jezik",
    description: "Jezik interfejsa",
  },

  smartLibrary: {
    title: "Pametna biblioteka",
    description: "Držite sveža predavanja spremna i čistite ih posle slušanja",
    enable: "Uključi",
    hint: "Aplikacija drži bafer neodslušanih predavanja i automatski uklanja završena. Koristite filter da izaberete šta se stavlja u red.",
    sections: {
      filter: "Šta preuzimati",
      target: "Dužina reda",
      archive: "Arhiviraj posle slušanja",
    },
    filter: {
      label: "Filter",
      none: "Sva predavanja",
    },
    target: {
      off: "Isključeno",
      "30m": "30 minuta",
      "1h": "1 sat",
      "2h": "2 sata",
      "3h": "3 sata",
      "5h": "5 sati",
      "8h": "8 sati",
      "10h": "10 sati",
    },
    archive: {
      immediate: "Odmah",
      _8h: "Posle 8 sati",
      _1d: "Posle 1 dana",
      _2d: "Posle 2 dana",
      _3d: "Posle 3 dana",
    },
    subtitleOff: "Automatsko ažuriranje predavanja i čišćenje posle slušanja",
    subtitleArchivePrefix: "arhiva",
  },

  preferredServer: {
    title: "Željeni server",
  },

  trackInfo: {
    label: "Informacije o numeri",
    description: "Podesite izgled liste numera",
    title: "Informacije o numeri",
    top: "Gornji red",
    topField: "Polje",
    bottom: "Donji red",
    none: "Ništa",
    fields: {
      reference: "Izvor",
      author: "Autor",
      location: "Lokacija",
      date: "Datum",
      duration: "Trajanje",
    },
    preview: {
      title: "Sreća izvan čula",
      author: "A. Č. Bhaktivedanta Svami",
      location: "Bombaj",
      date: "21. apr. 1974",
      duration: "47min",
    },
  },
  player: {
    showProgress: {
      title: "Napredak u plejeru",
      description: "Prikaži napredak oko dugmeta za reprodukciju",
    },
    autoPlayNext: {
      title: "Automatska reprodukcija",
      description: "Kada se predavanje završi, pokreni sledeće sa vaše liste numera",
    },
  },
  notes: {
    showPlayer: {
      title: "Plejer na stranici beleški",
      description: "Prikaži ugrađeni audio plejer pored svakog citata",
    },
  },
  activityTracker: {
    show: {
      title: "Pratilac aktivnosti",
      description: "Prikaži toplotnu mapu slušanja na početnom ekranu",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Istakni rečenicu",
      description: "Prati trenutnu rečenicu u transkriptu",
    },
    autoScroll: {
      title: "Automatsko skrolovanje",
      description: "Prati trenutni pasus dok audio svira",
    },
    showAutomatically: {
      title: "Automatski otvori transkript",
      description: "Otvori transkript pri reprodukciji predavanja",
    },
  },

  contacts: {
    email: {
      title: "Pošaljite nam e-poruku",
      description: "Imate pitanja ili predloge?",
      emailSubject: "Zahtev za podršku",
      emailIntro: "Molimo opišite svoje pitanje ili problem iznad ove linije.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Obaveštenja",
      description: "Primaćete obaveštenja.",
    },
    daily: {
      title: "Vreme podsetnika",
      description: "Vreme kada će obaveštenja biti poslata.",
    },
  },

  data: {
    export: {
      title: "Izvezi korisničke podatke",
      description: "Sačuvaj listu numera, beleške i napredak u datoteku",
      error: "Izvoz nije uspeo",
    },
    import: {
      title: "Uvezi korisničke podatke",
      description: "Zameni trenutne podatke prethodno izvezenom datotekom",
      error: "Uvoz nije uspeo",
      confirm: {
        header: "Zameniti sve trenutne podatke?",
        message:
          "Vaša trenutna lista numera, beleške, preuzimanja i napredak slušanja biće zamenjeni uvezenom datotekom. Ova radnja se ne može poništiti.",
        ok: "Zameni",
        cancel: "Otkaži",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Pogledaj zapise",
      description: "Zapis događaja u aplikaciji · {count} unosa",
    },
  },

  logs: {
    title: "Zapisi",
    close: "Zatvori",
    copy: "Kopiraj",
    copied: "Zapisi su kopirani",
    clear: "Očisti",
    count: "{count} unosa",
    empty: "Još nema zapisa",
  },

  danger: {
    clearCache: {
      title: "Očisti keš",
      description: "Uklanja sve preuzete audio snimke i transkripte",
    },
  },

  appVersion: "Verzija aplikacije",
  contentDatabase: "Baza predavanja",
  activeServer: "Aktivni CDN",
}
