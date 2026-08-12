// AUTO-GENERATED from ../sr-Latn by modules/tools/sr-transliterate/generate-sr-cyrl.mjs
// Do not edit by hand — re-run the generator instead.
export default {
  groups: {
    subscription: "Претплата",
    account: "Налог",
    appearance: "Изглед",
    library: "Библиотека",
    chat: "Питај Садхуа",
    contacts: "Контактирајте нас",
    status: "Статус",
    sadhana: "Садхана",
    data: "Подаци",
    help: "Помоћ",
    debug: "Отклањање грешака",
    danger: "Опасна зона",
    about: "О апликацији",
  },
  libraryLanguages: {
    title: "Језици предавања",
    description: "Прикажи предавања на овим језицима у претрази, темама и препорукама.",
  },

  chatLanguage: {
    title: "Језик ћаскања",
    description: "Језик на којем Садху одговара.",
  },

  chatTranslateCitations: {
    title: "Преведи цитате",
    description: "Преведи цитате на језик ћаскања.",
  },

  syncChats: {
    title: "Синхронизуј ћаскања",
    description: "Држите своје Ask Sadhu разговоре усклађене на свим уређајима.",
  },

  account: {
    signInCta: {
      title: "Пријавите се",
      description: "Сачувајте свој напредак",
    },
    signInWithGoogle: "Путем Google-а",
    signInWithApple: "Путем Apple-а",
    signInWithEmail: "Настави путем е-поште",
    email: {
      title: "Пријава путем е-поште",
      emailStep: "Послаћемо вам једнократни код на е-пошту — лозинка није потребна.",
      emailLabel: "Е-пошта",
      emailPlaceholder: "yоу{'@'}еxампле.цом",
      sendCode: "Пошаљи код",
      codeStep: "Унесите шестоцифрени код који смо послали на {email}.",
      codeLabel: "Код",
      codePlaceholder: "Шестоцифрени код",
      verify: "Пријави се",
      resend: "Пошаљи код поново",
      resendIn: "Поново за {seconds} с",
      changeEmail: "Промени е-пошту",
      errors: {
        invalidEmail: "Унесите исправну адресу е-поште.",
        invalidCode: "Код није исправан или је истекао.",
        throttled: "Сачекајте мало пре него што затражите нови код.",
        disabled: "Пријава путем е-поште тренутно није доступна.",
        network: "Нема везе. Проверите интернет и покушајте поново.",
        server: "Нешто је пошло по злу на нашој страни. Покушајте за тренутак.",
        generic: "Нешто је пошло по злу. Покушајте поново.",
      },
    },
    signedIn: "Пријављени сте",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Ваш напредак је безбедан",
    signOut: "Одјави се",
    signOutWipeToast:
      "Одјављени сте. Ваше белешке и разговори остају на налогу и вратиће се при следећој пријави.",
    deleteAccount: {
      title: "Обриши налог",
      confirmWipe: "Обриши налог и избриши податке",
      confirmKeep: "Обриши налог, задржи податке",
      errorToast: "Није могуће обрисати налог. Покушајте поново.",
      alreadyDeletedToast: "Ваш налог је већ обрисан.",
      rateLimitedToast: "Сачекајте мало пре него што покушате поново.",
      networkErrorToast: "Нема везе. Проверите интернет и покушајте поново.",
      serverErrorToast: "Нешто је пошло по злу на нашој страни. Покушајте за тренутак.",
    },
  },

  subscription: {
    title: "Претплата",
    description: "Управљање претплатом",
    subscriptionIsActive: "Претплата је активна",
    tapToManage: "Отвори и управљај",
    choose: "Подржите „Слушај Садхуа“",
    subscribe: "Претплати се",
    trialBadge: "{days} дана бесплатно",
    trialThenPrice: "затим {price} / {period}",
    startFreeTrial: "Започни бесплатну пробу",
    trialDisclaimer: "Откажите било кад. После пробног периода претплата се аутоматски обнавља.",
    disclaimer: "Откажите било кад. Претплата се аутоматски обнавља.",
    subscribed: "Претплата је обављена",
    loading: "Учитавање опција претплате…",
    unavailable: "Куповине унутар апликације нису доступне на овом уређају.",
    manage: "Управљање претплатом",
    restore: "Врати",
    restored: "Ваша претплата је успешно враћена!",
    error: "Дошло је до грешке током операције. Покушајте поново.",
    noSubscriptionFound:
      "Активна претплата није пронађена. Претплатите се да бисте приступили Pro функцијама.",
    thanks:
      "Хвала вам на претплати и подршци 🙏 Нека вам срце буде испуњено срећом, а сваки дан вас приближи Истини. Драго нам је што сте са нама на овом путу.",
    benefits: {
      progress: {
        title: "Пратите свој напредак",
        description: "Пратите свој низ слушања и наставите где сте стали.",
      },
      andMore: {
        title: "И још много тога",
        description: "Непрекидна репродукција, дељење, студио белешки и још много тога.",
      },
      intro:
        "Уводимо нове функције и побољшања. Ваша подршка нам помаже да наставимо развој и учинимо производ бољим.",
      benefit0: {
        title: "Нова предавања",
        description: "Ваша претплата нам помаже да додајемо нова предавања.",
      },
      benefit1: {
        title: "Обележивачи",
        description: "Сачувајте кључне тренутке предавања да им се вратите или их поделите.",
      },
      benefit2: {
        title: "Паметна библиотека",
        description: "Држи свежа предавања на уређају и аутоматски уклања одслушана.",
      },
      benefit3: {
        title: "Семинари и курсеви",
        description: "Додајте семинаре и курсеве на листу нумера да их слушате повољним редом.",
      },
      benefit4: {
        title: "Динамичке колекције",
        description:
          "Креирајте колекције предавања које ће се аутоматски ажурирати према задатим критеријумима.",
      },
      sakha: {
        title: "Питај Садхуа",
        description: "Претражује предавања, аудио и књиге и објашњава учења.",
      },
      autoScroll: {
        title: "Аутоматско скроловање",
        description: "Транскрипт прати аудио, па је тренутни пасус увек пред очима.",
      },
      continuousPlayback: {
        title: "Непрекидна репродукција",
        description:
          "Предавања иду једно за другим — када се једно заврши, следеће почиње аутоматски, чак и са закључаним екраном.",
      },
      shareTranscript: {
        title: "Дели и извези",
        description:
          "Поделите предавање као PDF или текстуални транскрипт, или поделите аудио — са било ким.",
      },
      notesStudio: {
        title: "Студио за белешке",
        description:
          "Претворите своје белешке из предавања у кратке видео снимке и поделите их са пријатељима.",
      },
      trackInfo: {
        title: "Распоред информација о нумери",
        description:
          "Изаберите који детаљ — извор, аутор, локација, датум — стоји у истакнутом горњем реду испод наслова предавања, а који се приказују у реду испод.",
      },
    },
    periods: {
      P1M: "месец",
      P3M: "3 месеца",
      P6M: "6 месеци",
      P1Y: "година",
    },
    plans: {
      $rc_monthly: "Месечна",
      $rc_three_month: "Тромесечна",
      $rc_six_month: "Полугодишња",
      $rc_annual: "Годишња",
    },
    legal: {
      privacy: "Политика приватности",
      terms: "Услови коришћења",
    },
  },

  help: {
    open: {
      title: "Отвори помоћ",
      description: "Објашњени индикатори, подешавања и функције",
    },
    privacyPolicy: {
      title: "Политика приватности",
      description: "Шта прикупљамо, подизвођачи, брисање налога",
    },
  },

  appLanguage: {
    title: "Језик",
    description: "Језик интерфејса",
    loadFailedToast: "Није могуће учитати тај језик. Покушајте поново.",
  },

  downloadLimit: {
    title: "Ограничење преузимања",
    unlimited: "Без ограничења",
    usage: "{used} од {limit}",
    usageUnlimited: "Преузето {used}",
  },

  smartLibrary: {
    title: "Паметна библиотека",
    description: "Држите свежа предавања спремна и чистите их после слушања",
    enable: "Укључи",
    hint: "Апликација држи бафер неодслушаних предавања и аутоматски уклања завршена. Користите филтер да изаберете шта се ставља у ред.",
    sections: {
      filter: "Шта преузимати",
      target: "Дужина реда",
      archive: "Архивирај после слушања",
    },
    filter: {
      label: "Филтер",
      none: "Сва предавања",
    },
    target: {
      off: "Искључено",
      "30m": "30 минута",
      "1h": "1 сат",
      "2h": "2 сата",
      "3h": "3 сата",
      "5h": "5 сати",
      "8h": "8 сати",
      "10h": "10 сати",
    },
    archive: {
      off: "Никада",
      immediate: "Одмах",
      _8h: "После 8 сати",
      _1d: "После 1 дана",
      _2d: "После 2 дана",
      _3d: "После 3 дана",
    },
    subtitleOff: "Аутоматско ажурирање предавања и чишћење после слушања",
    subtitleArchivePrefix: "архива",
  },

  preferredServer: {
    title: "Жељени сервер",
  },

  trackInfo: {
    label: "Информације о нумери",
    description: "Подесите изглед листе нумера",
    title: "Информације о нумери",
    top: "Горњи ред",
    topField: "Поље",
    bottom: "Доњи ред",
    none: "Ништа",
    fields: {
      reference: "Извор",
      author: "Аутор",
      location: "Локација",
      date: "Датум",
      duration: "Трајање",
    },
    preview: {
      title: "Срећа изван чула",
      author: "А. Ч. Бхактиведанта Свами",
      location: "Бомбај",
      date: "21. апр. 1974",
      duration: "47мин",
    },
  },
  player: {
    showProgress: {
      title: "Напредак у плејеру",
      description: "Прикажи напредак око дугмета за репродукцију",
    },
    autoPlayNext: {
      title: "Аутоматска репродукција",
      description: "Када се предавање заврши, покрени следеће са ваше листе нумера",
    },
  },
  notes: {
    showPlayer: {
      title: "Плејер на страници белешки",
      description: "Прикажи уграђени аудио плејер поред сваког цитата",
    },
  },
  activityTracker: {
    show: {
      title: "Пратилац активности",
      description: "Прикажи топлотну мапу слушања на почетном екрану",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Истакни реченицу",
      description: "Прати тренутну реченицу у транскрипту",
    },
    autoScroll: {
      title: "Аутоматско скроловање",
      description: "Прати тренутни пасус док аудио свира",
    },
    showAutomatically: {
      title: "Аутоматски отвори транскрипт",
      description: "Отвори транскрипт при репродукцији предавања",
    },
  },

  contacts: {
    studio: {
      title: "Јива Студио",
      description: "Посетите наш студио и откријте наше друге апликације",
    },
    email: {
      title: "Пошаљите нам е-поруку",
      description: "Имате питања или предлоге?",
      emailSubject: "Захтев за подршку",
      emailIntro: "Молимо опишите своје питање или проблем изнад ове линије.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Обавештења",
      description: "Примаћете обавештења.",
    },
    daily: {
      title: "Време подсетника",
      description: "Време када ће обавештења бити послата.",
    },
  },

  data: {
    export: {
      title: "Извези корисничке податке",
      description: "Сачувај листу нумера, белешке и напредак у датотеку",
      error: "Извоз није успео",
    },
    import: {
      title: "Увези корисничке податке",
      description: "Замени тренутне податке претходно извезеном датотеком",
      error: "Увоз није успео",
      confirm: {
        header: "Заменити све тренутне податке?",
        message:
          "Ваша тренутна листа нумера, белешке, преузимања и напредак слушања биће замењени увезеном датотеком. Ова радња се не може поништити.",
        ok: "Замени",
        cancel: "Откажи",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Погледај записе",
      description: "Запис догађаја у апликацији · {count} уноса",
    },
    email: {
      title: "Пошаљи дијагностику",
      description: "Пошаљите логове и стање система подршци",
      emailSubject: "Извештај о дијагностици",
      emailIntro: "Молимо опишите своје питање или проблем изнад ове линије.",
    },
  },

  logs: {
    title: "Записи",
    close: "Затвори",
    copy: "Копирај",
    copied: "Записи су копирани",
    clear: "Очисти",
    count: "{count} уноса",
    empty: "Још нема записа",
  },

  danger: {
    clearCache: {
      title: "Очисти кеш",
      description: "Уклања све преузете аудио снимке и транскрипте",
    },
  },

  appVersion: "Верзија апликације",
  contentDatabase: "База предавања",
  activeServer: "Активни CDN",
}
