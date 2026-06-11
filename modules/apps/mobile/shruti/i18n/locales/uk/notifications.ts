export default {
  enableDailyNotifications:
    "Увімкніть нагадування. Вони допоможуть підтримувати садгану й залишатися натхненними.",
  timeToListen: "Час послухати садгу!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Давно вас не було — свіжі лекції чекають на вас.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Ви не завершили «{title}». Торкніться, щоб повернутися й дослухати.",
}
