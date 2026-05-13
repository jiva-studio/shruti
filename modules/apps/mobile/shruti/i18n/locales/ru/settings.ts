export default {
  groups: {
    appearance: "Внешний вид",
    contacts: "Связаться с нами",
    status: "Статус",
    sadhana: "Садхана",
    data: "Данные",
    danger: "Опасная зона",
    about: "О приложении",
  },

  appLanguage: {
    title: "Язык",
    description: "Язык интерфейса",
  },

  server: {
    title: "Сервер",
    description: "Сеть доставки контента",
  },

  player: {
    showProgress: {
      title: "Прогресс проигрывания",
      description: "Индикатор вокруг кнопки воспроизведения",
    },
  },
  notes: {
    showTab: {
      title: "Вкладка заметок",
      description: "Показывать вкладку заметок внизу",
    },
  },
  activityTracker: {
    show: {
      title: "Трекер активности",
      description: "Показывать хитмап прослушивания на главной",
    },
  },
  transcript: {
    highlightCurrentSentence: {
      title: "Выделение предложения",
      description: "Следить за текущим предложением в тексте",
    },
    showAutomatically: {
      title: "Открывать транскрипт",
      description: "Автоматически при воспроизведении лекции",
    },
  },

  contacts: {
    socialNetworks: {
      title: "Социальные сети",
      description: "Будем на связи",
    },
    email: {
      title: "Напишите нам",
      description: "Есть вопросы или предложения?",
    },
  },

  notifications: {
    enabled: {
      title: "Уведомления",
      description: "Вы будете получать уведомления.",
    },
    daily: {
      title: "Время напоминания",
      description: "Время, когда будут отправляться уведомления.",
    },
  },

  data: {
    export: {
      title: "Экспорт данных",
      description: "Сохранить плейлист, заметки и прогресс в файл",
      error: "Не удалось экспортировать данные",
    },
    import: {
      title: "Импорт данных",
      description: "Заменить текущие данные ранее сохранённым файлом",
      error: "Не удалось импортировать данные",
      confirm: {
        header: "Заменить все текущие данные?",
        message:
          "Текущий плейлист, заметки, загрузки и прогресс прослушивания будут заменены данными из файла. Это нельзя отменить.",
        ok: "Заменить",
        cancel: "Отмена",
      },
    },
  },

  danger: {
    clearCache: {
      title: "Очистить кеш",
      description: "Удаляет загруженные транскрипты",
    },
    clearUserData: {
      title: "Очистить данные",
      description: "Удаляет все треки, плейлисты, заметки и закладки",
    },
    confirmClearUserData: {
      header: "Очистить все данные?",
      message:
        "Заметки, плейлист, скачанные треки и фильтры поиска будут удалены без возможности восстановления.",
      cancel: "Отмена",
      confirm: "Удалить всё",
    },
  },

  appVersion: "Версия приложения",
  contentDatabase: "База лекций",
  activeServer: "Активный CDN",
}
