export default {
  enableDailyNotifications:
    "Uključite podsetnike. Pomoći će vam da održite svoju sadhanu i ostanete nadahnuti.",
  timeToListen: "Vreme je da slušate sadhua!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Prošlo je nekoliko dana — sveža predavanja vas čekaju.",
  proactiveInactivityBody7: "Nedelju dana bez predavanja. Vratite se i nastavimo.",
  proactiveInactivityBody14:
    "Dve nedelje vas nema. Vaša praksa vam nedostaje — dodirnite da se vratite.",
  proactiveInactivityBody30: "Prošao je ceo mesec. Jedan dodir vraća vas u tok.",
  proactiveInactivityBody60: "Dugo vas nije bilo. Možda je vreme da se vratite predavanjima?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Niste dovršili „{title}“. Dodirnite da se vratite i završite.",
}
