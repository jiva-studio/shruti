export default {
  enableDailyNotifications:
    "Aktiviere Erinnerungen. Sie helfen dir, deine Sādhana aufrechtzuerhalten und inspiriert zu bleiben.",
  timeToListen: "Es ist Zeit, einem Sadhu zu lauschen!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Lange nicht gesehen — frische Vorträge warten auf dich.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Du hast „{title}“ noch nicht zu Ende gehört. Tippe, um zurückzukehren und ihn abzuschließen.",
}
