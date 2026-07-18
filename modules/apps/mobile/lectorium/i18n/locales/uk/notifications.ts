export default {
  enableDailyNotifications:
    "Увімкніть нагадування. Вони допоможуть підтримувати садгану й залишатися натхненними.",
  timeToListen: "Час послухати садгу!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Минуло кілька днів — свіжі лекції чекають на вас.",
  proactiveInactivityBody7: "Тиждень без лекції. Повертайтеся, і продовжимо разом.",
  proactiveInactivityBody14:
    "Уже два тижні. Ваша практика сумує за вами — торкніться, щоб повернутися.",
  proactiveInactivityBody30: "Минув цілий місяць. Один дотик поверне вас у потік.",
  proactiveInactivityBody60: "Вас давно не було. Можливо, час повернутися до лекцій?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Ви не завершили «{title}». Торкніться, щоб повернутися й дослухати.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Садху відповів",
  chatAnswerReadyBody: "Ваша відповідь готова.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Нове повідомлення",
  proactiveNewMessageToast: "Садху має для вас нове повідомлення.",
  proactiveNewMessagesTitle: "Нові повідомлення",
  proactiveNewMessagesToast: "Садху має для вас нові повідомлення ({count}).",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Відкрити",
}
