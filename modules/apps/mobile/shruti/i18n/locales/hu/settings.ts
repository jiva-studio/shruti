export default {
  groups: {
    subscription: "Előfizetés",
    account: "Fiók",
    appearance: "Megjelenés",
    chat: "Kérdezd Sadhut",
    contacts: "Lépj kapcsolatba velünk",
    status: "Állapot",
    sadhana: "Szádhana",
    data: "Adatok",
    help: "Súgó",
    debug: "Hibakeresés",
    danger: "Veszélyes zóna",
    about: "Az alkalmazásról",
  },

  account: {
    signInCta: {
      title: "Bejelentkezés",
      description: "Őrizd meg a haladásodat",
    },
    signInWithGoogle: "Folytatás Google-fiókkal",
    signInWithApple: "Folytatás Apple-fiókkal",
    signedIn: "Be vagy jelentkezve",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "A haladásod biztonságban van",
    signOut: "Kijelentkezés",
    deleteAccount: {
      title: "Fiók törlése",
      confirmWipe: "Fiók törlése és adatok törlése",
      confirmKeep: "Fiók törlése, adatok megtartása",
      errorToast: "Nem sikerült törölni a fiókot. Kérlek, próbáld újra.",
      alreadyDeletedToast: "A fiókod már törölve van.",
      rateLimitedToast: "Kérlek, várj egy kicsit, mielőtt újra próbálnád.",
      networkErrorToast: "Nincs kapcsolat. Ellenőrizd az internetet, és próbáld újra.",
      serverErrorToast:
        "Valami elromlott a mi oldalunkon. Kérlek, próbáld újra egy pillanat múlva.",
    },
  },

  subscription: {
    title: "Előfizetés",
    description: "Előfizetés kezelése",
    subscriptionIsActive: "Az előfizetés aktív",
    tapToManage: "Koppints a megtekintéshez vagy kezeléshez",
    choose: "Támogasd a „Shruti”-t",
    subscribe: "Előfizetés",
    trialBadge: "{days} nap ingyen",
    trialThenPrice: "utána {price} / {period}",
    startFreeTrial: "Ingyenes próba indítása",
    trialDisclaimer:
      "Bármikor lemondható. A próbaidőszak után az előfizetés automatikusan megújul.",
    subscribed: "Az előfizetés megtörtént",
    manage: "Előfizetés kezelése",
    restore: "Visszaállítás",
    restored: "Az előfizetésedet sikeresen visszaállítottuk!",
    error: "A művelet közben hiba történt. Kérlek, próbáld újra.",
    noSubscriptionFound:
      "Nem található aktív előfizetés. Fizess elő a prémium funkciók eléréséhez.",
    cantPay: "Nem tudok fizetni",
    cantPayEmailSubject: "Nem tudok fizetni",
    cantPayEmailIntro: "Nem tudok fizetni.",
    thanks:
      "Köszönjük az előfizetésedet és a támogatásodat 🙏 Töltse el szívedet boldogság, és minden nap közelebb vigyen az Igazsághoz. Örülünk, hogy velünk tartasz ezen az úton.",
    benefits: {
      intro:
        "Új funkciókat és fejlesztéseket vezetünk be. A te támogatásod segít, hogy folytathassuk a fejlesztést, és jobbá tegyük a terméket.",
      benefit0: {
        title: "Új előadások",
        description: "Az előfizetésed segít, hogy folytathassuk az új előadások hozzáadását.",
      },
      benefit1: {
        title: "Könyvjelzők",
        description:
          "Mentsd el a fontos pillanatokat az előadások szövegéből és hangjából, hogy később visszatérhess hozzájuk, vagy megoszthasd barátaiddal.",
      },
      benefit2: {
        title: "Okos könyvtár",
        description:
          "Az alkalmazás friss előadásokat tart az eszközödön, és automatikusan eltávolítja a befejezetteket.",
      },
      benefit3: {
        title: "Szemináriumok és kurzusok",
        description:
          "Adj hozzá szemináriumokat és kurzusokat a lejátszási listádhoz, hogy kényelmes sorrendben hallgathasd őket.",
      },
      benefit4: {
        title: "Dinamikus gyűjtemények",
        description:
          "Hozz létre gyűjteményeket előadásokhoz, amelyek a megadott feltételek alapján automatikusan frissülnek.",
      },
      sakha: {
        title: "Kérdezd Sadhut",
        description:
          "Előadásokban, hangokban és könyvekben keres, shlókákat talál, PDF-eket készít, és segít megérteni a tanításokat. Az előfizetéssel nagyobb napi keret jár.",
      },
      autoScroll: {
        title: "Automatikus görgetés",
        description:
          "Az átirat együtt halad a lejátszott hanggal, így az aktuális bekezdés mindig látszik.",
      },
      continuousPlayback: {
        title: "Folyamatos lejátszás",
        description:
          "Az előadások egymás után szólnak — amikor az egyik véget ér, automatikusan elindul a következő, lezárt képernyő mellett is.",
      },
      shareTranscript: {
        title: "Megosztás és exportálás",
        description:
          "Oszd meg az előadást PDF-ként vagy szöveges átiratként, vagy oszd meg a hangot — bárkivel.",
      },
      notesStudio: {
        title: "Jegyzetstúdió",
        description:
          "Alakítsd az előadásokból készült jegyzeteidet rövid videókká, és oszd meg őket barátaiddal.",
      },
      trackInfo: {
        title: "Felvételadatok elrendezése",
        description:
          "Válaszd ki, melyik adat — hivatkozás, szerző, helyszín, dátum — kerüljön a hangsúlyos felső sorba az előadás címe alatt, és melyek jelenjenek meg az alatti sorban.",
      },
    },
    periods: {
      P1M: "hónap",
      P3M: "3 hónap",
      P6M: "6 hónap",
      P1Y: "év",
    },
    plans: {
      $rc_monthly: "Havi",
      $rc_three_month: "Negyedéves",
      $rc_six_month: "Féléves",
      $rc_annual: "Éves",
    },
    legal: {
      privacy: "Adatvédelmi irányelvek",
      terms: "Felhasználási feltételek",
    },
  },

  help: {
    open: {
      title: "Súgó megnyitása",
      description: "Jelzők, beállítások és funkciók elmagyarázva",
    },
    privacyPolicy: {
      title: "Adatvédelmi irányelvek",
      description: "Mit gyűjtünk, aladatfeldolgozók, fióktörlés",
    },
  },

  appLanguage: {
    title: "Nyelv",
    description: "A felület nyelve",
  },

  chatLanguage: {
    title: "Csevegés nyelve",
    description: "Az a nyelv, amelyen Sadhu válaszol.",
  },

  chatTranslateCitations: {
    title: "Idézetek fordítása",
    description: "Az idézetek lefordítása a csevegés nyelvére.",
  },

  smartLibrary: {
    title: "Okos könyvtár",
    description: "Tartsd készenlétben a friss előadásokat, és takaríts el hallgatás után",
    enable: "Bekapcsolás",
    hint: "Az alkalmazás tartalékot tart a meg nem hallgatott előadásokból, és automatikusan eltávolítja a befejezetteket. A szűrővel választhatod ki, mi kerüljön a sorba.",
    sections: {
      filter: "Mit töltsön le",
      target: "Sor hossza",
      archive: "Archiválás hallgatás után",
    },
    filter: {
      label: "Szűrő",
      none: "Minden előadás",
    },
    target: {
      off: "Kikapcsolva",
      "30m": "30 perc",
      "1h": "1 óra",
      "2h": "2 óra",
      "3h": "3 óra",
      "5h": "5 óra",
      "8h": "8 óra",
      "10h": "10 óra",
    },
    archive: {
      immediate: "Azonnal",
      _8h: "8 óra után",
      _1d: "1 nap után",
      _2d: "2 nap után",
      _3d: "3 nap után",
    },
    subtitleOff: "Előadások automatikus frissítése és tisztítás hallgatás után",
    subtitleArchivePrefix: "archiválás",
  },

  preferredServer: {
    title: "Előnyben részesített szerver",
  },

  trackInfo: {
    label: "Felvételadatok",
    description: "A felvétellista megjelenésének beállítása",
    title: "Felvételadatok",
    top: "Felső sor",
    topField: "Mező",
    bottom: "Alsó sor",
    none: "Semmi",
    fields: {
      reference: "Hivatkozás",
      author: "Szerző",
      location: "Helyszín",
      date: "Dátum",
      duration: "Hosszúság",
    },
    preview: {
      title: "Boldogság az érzékeken túl",
      author: "A.C. Bhaktivedanta Swami",
      location: "Bombay",
      date: "1974. ápr. 21.",
      duration: "47 p",
    },
  },
  player: {
    showProgress: {
      title: "Lejátszó haladásjelzője",
      description: "Haladás megjelenítése a lejátszás gomb körül",
    },
    autoPlayNext: {
      title: "Automatikus lejátszás",
      description: "Amikor egy előadás véget ér, indítsa el a következőt a lejátszási listádból",
    },
  },
  notes: {
    showPlayer: {
      title: "Lejátszó a jegyzetek oldalon",
      description: "Beágyazott hanglejátszó megjelenítése minden idézet mellett",
    },
  },
  activityTracker: {
    show: {
      title: "Aktivitáskövető",
      description: "Hallgatási hőtérkép megjelenítése a főoldalon",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Mondat kiemelése",
      description: "Az aktuális mondat követése az átiratban",
    },
    autoScroll: {
      title: "Automatikus görgetés",
      description: "Az aktuális bekezdés követése lejátszás közben",
    },
    showAutomatically: {
      title: "Átirat automatikus megnyitása",
      description: "Átirat megnyitása előadás lejátszásakor",
    },
  },

  contacts: {
    email: {
      title: "Írj nekünk e-mailt",
      description: "Kérdésed vagy javaslatod van?",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Értesítések",
      description: "Értesítéseket fogsz kapni.",
    },
    daily: {
      title: "Emlékeztető időpontja",
      description: "Az az időpont, amikor az értesítések megérkeznek.",
    },
  },

  data: {
    export: {
      title: "Felhasználói adatok exportálása",
      description: "Lejátszási lista, jegyzetek és haladás mentése fájlba",
      error: "Az exportálás nem sikerült",
    },
    import: {
      title: "Felhasználói adatok importálása",
      description: "Jelenlegi adatok lecserélése egy korábban exportált fájlra",
      error: "Az importálás nem sikerült",
      confirm: {
        header: "Lecseréled az összes jelenlegi adatot?",
        message:
          "A jelenlegi lejátszási listádat, jegyzeteidet, letöltéseidet és hallgatási haladásodat felülírja az importált fájl. Ezt nem lehet visszavonni.",
        ok: "Lecserélés",
        cancel: "Mégse",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Naplók megtekintése",
      description: "Alkalmazáson belüli eseménynapló · {count} bejegyzés",
    },
  },

  logs: {
    title: "Naplók",
    close: "Bezárás",
    copy: "Másolás",
    copied: "Naplók másolva",
    clear: "Törlés",
    count: "{count} bejegyzés",
    empty: "Még nincsenek naplók",
  },

  danger: {
    clearCache: {
      title: "Gyorsítótár törlése",
      description: "Eltávolítja az összes letöltött hangot és átiratot",
    },
  },

  appVersion: "Alkalmazás verziója",
  contentDatabase: "Tartalom-adatbázis",
  activeServer: "Aktív CDN",
}
