export default {
  enableDailyNotifications:
    "Aktiviere Erinnerungen. Sie helfen dir, deine Sādhana aufrechtzuerhalten und inspiriert zu bleiben.",
  timeToListen: "Es ist Zeit, einem Sadhu zu lauschen!",
  // Re-engagement pushes fired by the `inactivity` proactive rule. They
  // are scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived. The
  // numbered variants escalate gently with days of inactivity.
  proactiveInactivityBody3: "Ein paar Tage sind vergangen — frische Vorträge warten auf dich.",
  proactiveInactivityBody7: "Eine Woche ohne Vortrag. Komm zurück und lass uns weitermachen.",
  proactiveInactivityBody14:
    "Zwei Wochen fort. Deine Praxis vermisst dich — tippe, um zurückzukehren.",
  proactiveInactivityBody30:
    "Ein ganzer Monat ist vergangen. Ein Tippen bringt dich zurück in den Fluss.",
  proactiveInactivityBody60:
    "Es ist lange her. Vielleicht ist es Zeit, zu den Vorträgen zurückzukehren?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody:
    "Du hast „{title}“ noch nicht zu Ende gehört. Tippe, um zurückzukehren und ihn abzuschließen.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Sadhu hat geantwortet",
  chatAnswerReadyBody: "Deine Antwort ist bereit.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Neue Nachricht",
  proactiveNewMessageToast: "Sadhu hat eine neue Nachricht für dich.",
  proactiveNewMessagesTitle: "Neue Nachrichten",
  proactiveNewMessagesToast: "Sadhu hat neue Nachrichten für dich ({count}).",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Öffnen",
}
