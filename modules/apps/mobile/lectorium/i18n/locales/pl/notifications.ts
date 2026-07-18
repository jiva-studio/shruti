export default {
  enableDailyNotifications:
    "Włącz przypomnienia. Pomogą Ci utrzymać sadhanę i zachować inspirację.",
  timeToListen: "Czas posłuchać sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Minęło kilka dni — świeże wykłady już na Ciebie czekają.",
  proactiveInactivityBody7: "Tydzień bez wykładu. Wróć, a będziemy kontynuować.",
  proactiveInactivityBody14:
    "Dwa tygodnie nieobecności. Twoja praktyka tęskni — dotknij, aby wrócić.",
  proactiveInactivityBody30: "Minął cały miesiąc. Jedno dotknięcie i wracasz do rytmu.",
  proactiveInactivityBody60: "Dawno Cię nie było. Może czas wrócić do wykładów?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Nie dokończyłeś „{title}”. Dotknij, aby wrócić i dosłuchać.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Sadhu odpowiedział",
  chatAnswerReadyBody: "Twoja odpowiedź jest gotowa.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Nowa wiadomość",
  proactiveNewMessageToast: "Sadhu ma dla Ciebie nową wiadomość.",
  proactiveNewMessagesTitle: "Nowe wiadomości",
  proactiveNewMessagesToast: "Sadhu ma dla Ciebie nowe wiadomości ({count}).",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Otwórz",
}
