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
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Sadhu je odgovorio",
  chatAnswerReadyBody: "Vaš odgovor je spreman.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Nova poruka",
  proactiveNewMessageToast: "Sadhu ima novu poruku za vas.",
  proactiveNewMessagesTitle: "Nove poruke",
  proactiveNewMessagesToast: "Sadhu ima nove poruke za vas ({count}).",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Otvori",
}
