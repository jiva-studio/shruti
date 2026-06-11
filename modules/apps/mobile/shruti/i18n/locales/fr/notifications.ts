export default {
  enableDailyNotifications:
    "Activez les rappels. Ils vous aideront à maintenir votre sādhana et à rester inspiré.",
  timeToListen: "Il est temps d'écouter un sadhu !",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Cela fait un moment — de nouvelles conférences vous attendent.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Vous n'avez pas terminé « {title} ». Appuyez pour reprendre et la terminer.",
}
