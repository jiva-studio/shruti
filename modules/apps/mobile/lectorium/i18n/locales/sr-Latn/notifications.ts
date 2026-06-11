export default {
  enableDailyNotifications:
    "Uključite podsetnike. Pomoći će vam da održite svoju sadhanu i ostanete nadahnuti.",
  timeToListen: "Vreme je da slušate sadhua!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Dugo vas nije bilo — sveža predavanja vas čekaju.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Niste dovršili „{title}“. Dodirnite da se vratite i završite.",
}
