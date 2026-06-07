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
}
