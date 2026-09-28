export default {
  enableDailyNotifications:
    "Включите напоминания. Они помогут поддерживать садхану и оставаться вдохновлёнными!",
  timeToListen: "Время слушать садху!",
  // Escalating re-engagement pushes fired by the `inactivity` rule at
  // 3 / 7 / 14 / 30 / 60 days of no opens. Scheduled in the background, so
  // the copy is static; it warms from a gentle nudge to a final "it's been
  // a long while".
  proactiveInactivityBody3: "Прошло несколько дней — свежие лекции уже ждут тебя.",
  proactiveInactivityBody7: "Неделя без лекций. Возвращайся — продолжим вместе.",
  proactiveInactivityBody14: "Две недели в стороне. Практика скучает — нажми, чтобы вернуться.",
  proactiveInactivityBody30: "Прошёл целый месяц. Один тап — и ты снова в потоке.",
  proactiveInactivityBody60: "Давно не виделись. Может, самое время вернуться к лекциям?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Вы не дослушали «{title}». Нажмите, чтобы вернуться и закончить.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Sadhu ответил",
  chatAnswerReadyBody: "Ваш ответ готов.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Новое сообщение",
  proactiveNewMessageToast: "У Sadhu есть для вас новое сообщение.",
  // Grouped variant — shown when several proactive messages surface in the
  // same tick (app open). `{count}` is parenthesised so no locale needs
  // noun-case agreement with the number.
  proactiveNewMessagesTitle: "Новые сообщения",
  proactiveNewMessagesToast: "У Sadhu для вас новые сообщения ({count}).",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Открыть",
}
