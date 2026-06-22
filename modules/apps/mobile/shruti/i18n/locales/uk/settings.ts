export default {
  groups: {
    subscription: "Підписка",
    account: "Обліковий запис",
    appearance: "Зовнішній вигляд",
    library: "Бібліотека",
    chat: "Запитай Садху",
    contacts: "Зв'язатися з нами",
    status: "Статус",
    sadhana: "Садгана",
    data: "Дані",
    help: "Довідка",
    debug: "Налагодження",
    danger: "Небезпечна зона",
    about: "Про застосунок",
  },
  libraryLanguages: {
    title: "Мови лекцій",
    description: "Показувати лекції цими мовами в пошуку, темах і рекомендаціях.",
  },

  chatLanguage: {
    title: "Мова чату",
    description: "Мова відповідей Садху.",
  },

  chatTranslateCitations: {
    title: "Перекладати цитати",
    description: "Перекладати цитати мовою чату.",
  },

  account: {
    signInCta: {
      title: "Увійти",
      description: "Збережіть свій прогрес",
    },
    signInWithGoogle: "Через Google",
    signInWithApple: "Через Apple",
    signedIn: "Ви увійшли",
    // Subtitle for the signed-in row when the auth provider didn't
    // expose email/picture (RU region: no personal data by design;
    // also any OAuth flow that withheld the profile). Reassures the
    // user that their session is still attached to something
    // persistent even without a visible identity.
    signedInNoDataSubtitle: "Ваш прогрес у безпеці",
    signOut: "Вийти",
    deleteAccount: {
      title: "Видалити обліковий запис",
      confirmWipe: "Видалити запис і стерти дані",
      confirmKeep: "Видалити запис, залишити дані",
      errorToast: "Не вдалося видалити обліковий запис. Спробуйте ще раз.",
      alreadyDeletedToast: "Ваш обліковий запис уже видалено.",
      rateLimitedToast: "Зачекайте трохи перед наступною спробою.",
      networkErrorToast: "Немає з'єднання. Перевірте інтернет і спробуйте ще раз.",
      serverErrorToast: "Щось пішло не так на нашому боці. Спробуйте за хвилину.",
    },
  },

  subscription: {
    title: "Підписка",
    description: "Керування підпискою",
    subscriptionIsActive: "Підписка активна",
    tapToManage: "Відкрити та керувати",
    choose: "Підтримайте «Слухай Садху»",
    subscribe: "Підписатися",
    trialBadge: "{days} днів безкоштовно",
    trialThenPrice: "далі {price} / {period}",
    startFreeTrial: "Спробувати безкоштовно",
    trialDisclaimer:
      "Скасувати можна будь-коли. Після пробного періоду підписка продовжиться автоматично.",
    disclaimer: "Скасувати можна будь-коли. Підписка продовжиться автоматично.",
    subscribed: "Підписку оформлено",
    unavailable: "Покупки в застосунку недоступні на цьому пристрої.",
    manage: "Керування підпискою",
    restore: "Відновити",
    restored: "Вашу підписку успішно відновлено!",
    error: "Під час операції сталася помилка. Спробуйте ще раз.",
    noSubscriptionFound:
      "Активної підписки не знайдено. Будь ласка, оформіть підписку, щоб отримати доступ до Pro-функцій.",
    cantPay: "Не можу оплатити",
    cantPayEmailSubject: "Не можу оплатити",
    cantPayEmailIntro: "Не можу оплатити.",
    thanks:
      "Дякуємо за підписку та підтримку 🙏 Нехай ваше серце наповнюється щастям, а кожен день наближає до Істини. Ми раді, що ви з нами на цьому шляху.",
    benefits: {
      progress: {
        title: "Стежте за прогресом",
        description: "Стежте за серією днів і продовжуйте з місця, де зупинилися.",
      },
      andMore: {
        title: "І багато іншого",
        description: "Безперервне відтворення, поширення, студія нотаток і багато іншого.",
      },
      intro:
        "Ми впроваджуємо нові функції та покращення. Ваша підтримка допомагає нам розвиватися й робити продукт кращим.",
      benefit0: {
        title: "Нові лекції",
        description: "Ваша підписка допомагає нам додавати нові лекції.",
      },
      benefit1: {
        title: "Закладки",
        description: "Зберігайте ключові моменти лекції, щоб повернутися чи поділитися.",
      },
      benefit2: {
        title: "Розумна бібліотека",
        description: "Тримає свіжі лекції на пристрої й прибирає прослухані.",
      },
      benefit3: {
        title: "Семінари та курси",
        description: "Додавайте семінари та курси до плейлиста, щоб слухати їх у зручному порядку.",
      },
      benefit4: {
        title: "Динамічні колекції",
        description:
          "Створюйте колекції лекцій, які автоматично оновлюватимуться за заданими критеріями.",
      },
      sakha: {
        title: "Запитай Садху",
        description: "Шукає в лекціях, аудіо та книгах і пояснює матеріал.",
      },
      autoScroll: {
        title: "Автопрокрутка",
        description: "Транскрипт слідує за аудіо — поточний абзац завжди перед очима.",
      },
      continuousPlayback: {
        title: "Безперервне відтворення",
        description:
          "Лекції йдуть одна за одною — коли закінчується одна, автоматично починається наступна, навіть при заблокованому екрані.",
      },
      shareTranscript: {
        title: "Поділитися",
        description:
          "Діліться лекцією: транскрипт у PDF або текстом, чи саме аудіо — з ким завгодно.",
      },
      notesStudio: {
        title: "Студія нотаток",
        description:
          "Перетворюйте свої нотатки з лекцій на короткі відео й діліться ними з друзями.",
      },
      trackInfo: {
        title: "Інформація про трек",
        description:
          "Виберіть, яка деталь — джерело, автор, місце, дата — буде на помітному верхньому рядку під назвою лекції, а які показувати в рядку нижче.",
      },
    },
    periods: {
      P1M: "місяць",
      P3M: "3 місяці",
      P6M: "півроку",
      P1Y: "рік",
    },
    plans: {
      $rc_monthly: "Щомісячна",
      $rc_three_month: "Щоквартальна",
      $rc_six_month: "Піврічна",
      $rc_annual: "Річна",
    },
    legal: {
      privacy: "Політика конфіденційності",
      terms: "Умови використання",
    },
  },

  help: {
    open: {
      title: "Відкрити довідку",
      description: "Пояснення індикаторів, налаштувань і функцій",
    },
    privacyPolicy: {
      title: "Політика конфіденційності",
      description: "Що ми збираємо, субпідрядники, видалення облікового запису",
    },
  },

  appLanguage: {
    title: "Мова",
    description: "Мова інтерфейсу",
  },

  smartLibrary: {
    title: "Розумна бібліотека",
    description: "Тримайте свіжі лекції напоготові й прибирайте після прослуховування",
    enable: "Увімкнути",
    hint: "Застосунок тримає буфер непрослуханих лекцій і автоматично прибирає завершені. Скористайтеся фільтром, щоб обрати, що ставити в чергу.",
    sections: {
      filter: "Що завантажувати",
      target: "Довжина черги",
      archive: "Архівувати після прослуховування",
    },
    filter: {
      label: "Фільтр",
      none: "Усі лекції",
    },
    target: {
      off: "Вимкнено",
      "30m": "30 хвилин",
      "1h": "1 година",
      "2h": "2 години",
      "3h": "3 години",
      "5h": "5 годин",
      "8h": "8 годин",
      "10h": "10 годин",
    },
    archive: {
      immediate: "Одразу",
      _8h: "За 8 годин",
      _1d: "За 1 день",
      _2d: "За 2 дні",
      _3d: "За 3 дні",
    },
    subtitleOff: "Автооновлення лекцій і прибирання після прослуховування",
    subtitleArchivePrefix: "архів",
  },

  preferredServer: {
    title: "Бажаний сервер",
  },

  trackInfo: {
    label: "Інформація про трек",
    description: "Налаштуйте вигляд списку треків",
    title: "Інформація про трек",
    top: "Верхній рядок",
    topField: "Поле",
    bottom: "Нижній рядок",
    none: "Нічого",
    fields: {
      reference: "Джерело",
      author: "Автор",
      location: "Місце",
      date: "Дата",
      duration: "Тривалість",
    },
    preview: {
      title: "Щастя поза почуттями",
      author: "А. Ч. Бгактіведанта Свамі",
      location: "Бомбей",
      date: "21 квіт. 1974",
      duration: "47хв",
    },
  },
  player: {
    showProgress: {
      title: "Прогрес у плеєрі",
      description: "Показувати прогрес навколо кнопки відтворення",
    },
    autoPlayNext: {
      title: "Автовідтворення",
      description: "Коли лекція закінчується, починати наступну з вашого плейлиста",
    },
  },
  notes: {
    showPlayer: {
      title: "Плеєр на сторінці нотаток",
      description: "Показувати вбудований аудіоплеєр біля кожної цитати",
    },
  },
  activityTracker: {
    show: {
      title: "Трекер активності",
      description: "Показувати теплову карту прослуховування на головному екрані",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Підсвічувати речення",
      description: "Слідкувати за поточним реченням у транскрипті",
    },
    autoScroll: {
      title: "Автопрокрутка",
      description: "Слідувати за поточним абзацом під час відтворення аудіо",
    },
    showAutomatically: {
      title: "Відкривати транскрипт автоматично",
      description: "Відкривати транскрипт під час відтворення лекції",
    },
  },

  contacts: {
    email: {
      title: "Написати нам",
      description: "Маєте запитання чи пропозиції?",
      emailSubject: "Запит до підтримки",
      emailIntro: "Будь ласка, опишіть своє запитання або проблему над цим рядком.",
    },
    // VK / Telegram rows render only in the ru locale (Russian-audience
    // communities), so their strings live solely in ru/settings.ts.
  },

  notifications: {
    enabled: {
      title: "Сповіщення",
      description: "Ви отримуватимете сповіщення.",
    },
    daily: {
      title: "Час нагадування",
      description: "Час, коли надсилатимуться сповіщення.",
    },
  },

  data: {
    export: {
      title: "Експорт даних користувача",
      description: "Зберегти плейлист, нотатки та прогрес у файл",
      error: "Не вдалося експортувати",
    },
    import: {
      title: "Імпорт даних користувача",
      description: "Замінити поточні дані раніше експортованим файлом",
      error: "Не вдалося імпортувати",
      confirm: {
        header: "Замінити всі поточні дані?",
        message:
          "Ваш поточний плейлист, нотатки, завантаження та прогрес прослуховування буде замінено імпортованим файлом. Цю дію не можна скасувати.",
        ok: "Замінити",
        cancel: "Скасувати",
      },
    },
  },

  debug: {
    viewLogs: {
      title: "Переглянути логи",
      description: "Журнал подій застосунку · {count} записів",
    },
  },

  logs: {
    title: "Логи",
    close: "Закрити",
    copy: "Копіювати",
    copied: "Логи скопійовано",
    clear: "Очистити",
    count: "{count} записів",
    empty: "Логів поки немає",
  },

  danger: {
    clearCache: {
      title: "Очистити кеш",
      description: "Видаляє всі завантажені аудіо та транскрипти",
    },
  },

  appVersion: "Версія застосунку",
  contentDatabase: "База лекцій",
  activeServer: "Активний CDN",
}
