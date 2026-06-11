export default {
  enableDailyNotifications:
    "Włącz przypomnienia. Pomogą Ci utrzymać sadhanę i zachować inspirację.",
  timeToListen: "Czas posłuchać sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Dawno Cię nie było — świeże wykłady już na Ciebie czekają.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Nie dokończyłeś „{title}”. Dotknij, aby wrócić i dosłuchać.",
}
