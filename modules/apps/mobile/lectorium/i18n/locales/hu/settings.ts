export default {
  groups: {
    subscription: "Előfizetés",
    account: "Fiók",
    appearance: "Megjelenés",
    library: "Könyvtár",
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
  libraryLanguages: {
    title: "Előadások nyelvei",
    description:
      "Ezeken a nyelveken jelenjenek meg az előadások a keresésben, a témákban és az ajánlásokban.",
  },

  account: {
    signInCta: {
      title: "Bejelentkezés",
      description: "Őrizd meg a haladásodat",
    },
    signInWithGoogle: "Folytatás Google-fiókkal",
    signInWithApple: "Folytatás Apple-fiókkal",
    signInWithEmail: "Folytatás e-maillel",
    email: {
      title: "Bejelentkezés e-maillel",
      emailStep: "Egyszer használatos kódot küldünk e-mailben — jelszó nem kell.",
      emailLabel: "E-mail",
      emailPlaceholder: "you{'@'}example.com",
      sendCode: "Kód küldése",
      codeStep: "Írd be a 6 jegyű kódot, amelyet erre küldtünk: {email}.",
      codeLabel: "Kód",
      codePlaceholder: "6 jegyű kód",
      verify: "Bejelentkezés",
      resend: "Kód újraküldése",
      resendIn: "Újraküldés {seconds} mp múlva",
      changeEmail: "E-mail módosítása",
      errors: {
        invalidEmail: "Adj meg egy érvényes e-mail-címet.",
        invalidCode: "Ez a kód érvénytelen vagy lejárt.",
        throttled: "Várj egy kicsit, mielőtt új kódot kérsz.",
        disabled: "Az e-mailes bejelentkezés jelenleg nem érhető el.",
        network: "Nincs kapcsolat. Ellenőrizd az internetet, és próbáld újra.",
        server: "Valami hiba történt nálunk. Próbáld újra egy pillanat múlva.",
        generic: "Valami hiba történt. Próbáld újra.",
      },
    },
    signedIn: "Be vagy jelentkezve",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "A haladásod biztonságban van",
    signOut: "Kijelentkezés",
    signOutWipeToast:
      "Kijelentkeztél. A jegyzeteid és beszélgetéseid a fiókodban maradnak, és a következő bejelentkezéskor visszatérnek. A letöltött előadások törlődtek erről az eszközről, és újra le kell tölteni őket.",
    signOutWipeToastChatLocal:
      "Kijelentkeztél. A jegyzeteid a fiókodban maradnak, és a következő bejelentkezéskor visszatérnek. A beszélgetések szinkronizálása ki volt kapcsolva, ezért csak ezen az eszközön voltak, és törlődtek. A letöltött előadások is törlődtek, és újra le kell tölteni őket.",
    signOutWipeUnsentSuffix:
      "A legutóbbi változtatásokat nem sikerült feltölteni a kijelentkezés előtt, és elvesztek.",
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
    disclaimer: "Bármikor lemondható. Az előfizetés automatikusan megújul.",
    subscribed: "Az előfizetés megtörtént",
    loading: "Előfizetési lehetőségek betöltése…",
    unavailable: "Az alkalmazáson belüli vásárlások nem érhetők el ezen az eszközön.",
    manage: "Előfizetés kezelése",
    restore: "Visszaállítás",
    restored: "Az előfizetésedet sikeresen visszaállítottuk!",
    error: "A művelet közben hiba történt. Kérlek, próbáld újra.",
    noSubscriptionFound:
      "Nem található aktív előfizetés. Fizess elő a prémium funkciók eléréséhez.",
    thanks:
      "Köszönjük az előfizetésedet és a támogatásodat 🙏 Töltse el szívedet boldogság, és minden nap közelebb vigyen az Igazsághoz. Örülünk, hogy velünk tartasz ezen az úton.",
    benefits: {
      progress: {
        title: "Kövesd a haladásod",
        description: "Kövesd a hallgatási sorozatod, és folytasd, ahol abbahagytad.",
      },
      andMore: {
        title: "És még sok más",
        description: "Folyamatos lejátszás, megosztás, a jegyzetstúdió és még sok más.",
      },
      intro:
        "Új funkciókat és fejlesztéseket vezetünk be. A te támogatásod segít, hogy folytathassuk a fejlesztést, és jobbá tegyük a terméket.",
      benefit0: {
        title: "Új előadások",
        description: "Az előfizetésed segít új előadásokat hozzáadni.",
      },
      benefit1: {
        title: "Könyvjelzők",
        description: "Mentsd el az előadás fontos pillanatait, hogy visszatérj vagy megoszd.",
      },
      benefit2: {
        title: "Okos könyvtár",
        description: "Friss előadásokat tart az eszközön, a befejezetteket eltávolítja.",
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
        description: "Előadásokban, hangban és könyvekben keres, és elmagyarázza a tanításokat.",
      },
      autoScroll: {
        title: "Automatikus görgetés",
        description: "Az átirat követi a hangot, az aktuális bekezdés mindig látszik.",
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
    loadFailedToast: "Ezt a nyelvet nem sikerült betölteni. Próbáld újra.",
  },

  chatLanguage: {
    title: "Csevegés nyelve",
    description: "Az a nyelv, amelyen Sadhu válaszol.",
  },

  chatTranslateCitations: {
    title: "Idézetek fordítása",
    description: "Az idézetek lefordítása a csevegés nyelvére.",
  },

  syncChats: {
    title: "Csevegések szinkronizálása",
    description: "Tartsd az Ask Sadhu beszélgetéseidet szinkronban az összes eszközödön.",
  },

  downloadLimit: {
    title: "Letöltési korlát",
    unlimited: "Nincs korlát",
    usage: "{used} / {limit}",
    usageUnlimited: "{used} letöltve",
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
      off: "Soha",
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
    studio: {
      title: "Jiva Studio",
      description: "Látogass el a stúdiónkba, és fedezd fel a többi alkalmazásunkat",
    },
    email: {
      title: "Írj nekünk e-mailt",
      description: "Kérdésed vagy javaslatod van?",
      emailSubject: "Támogatási kérés",
      emailIntro: "Kérlek, írd le a kérdésedet vagy problémádat e fölött a sor fölött.",
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
    email: {
      title: "Diagnosztika küldése",
      description: "Naplók és rendszerállapot küldése a támogatásnak",
      emailSubject: "Diagnosztikai jelentés",
      emailIntro: "Kérlek, írd le a kérdésedet vagy problémádat e fölött a sor fölött.",
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
