export default {
  enableDailyNotifications:
    "Включите напоминания. Они помогут поддерживать садхану и оставаться вдохновлёнными!",
  timeToListen: "Время слушать садху!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Давно вас не было — для вас уже готовы свежие лекции.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` — название лекции в локали пользователя.
  unfinishedLectureBody: "Вы не дослушали «{title}». Нажмите, чтобы вернуться и закончить.",
  // Показывается, когда ответ в чате готов, а приложение в фоне (или взведено
  // заранее при отправке, если приложение заморозится посреди ответа).
  // В заголовок подставляется название сессии, если оно есть (чтобы разные
  // чаты различались); этот общий заголовок — запасной. Без «нажмите, чтобы…»
  // — тап и так единственное действие, подсказка лишняя.
  chatAnswerReadyTitle: "Sadhu ответил",
  chatAnswerReadyBody: "Ваш ответ готов.",
  // Тост, когда проактивное сообщение появляется при активном приложении
  // (фоновая доставка — это отдельная запланированная нотификация).
  proactiveNewMessageToast: "У Sadhu есть для вас новое сообщение.",
  // Кнопка действия на тосте — открывает сессию чата.
  openButton: "Открыть",
}
