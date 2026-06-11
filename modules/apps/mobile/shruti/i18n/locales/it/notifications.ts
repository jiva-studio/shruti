export default {
  enableDailyNotifications:
    "Attiva i promemoria. Ti aiuteranno a mantenere la tua sadhana e a restare ispirato.",
  timeToListen: "È ora di ascoltare un sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "È passato un po' di tempo — nuove lezioni ti stanno aspettando.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Non hai finito “{title}”. Tocca per tornare e completarla.",
}
