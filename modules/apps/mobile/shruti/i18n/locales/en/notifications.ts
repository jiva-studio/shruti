export default {
  enableDailyNotifications:
    "Enable reminders. They will help you maintain your sadhana and stay inspired.",
  timeToListen: "It is time to listen to a sadhu!",
  // Escalating re-engagement pushes fired by the `inactivity` proactive
  // ladder at 3 / 7 / 14 / 30 / 60 days of no opens. Scheduled while the
  // app is backgrounded, so the copy is static; it warms from a gentle
  // nudge to a final "it's been a long while".
  proactiveInactivityBody3: "It's been a few days — fresh lectures are waiting for you.",
  proactiveInactivityBody7: "A week without a lecture. Come back and let's continue.",
  proactiveInactivityBody14: "Two weeks away. Your practice misses you — tap to return.",
  proactiveInactivityBody30: "A whole month has passed. One tap brings you back to the flow.",
  proactiveInactivityBody60: "It's been a long while. Maybe it's time to return to the lectures?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "You haven't finished “{title}”. Tap to return and complete it.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Sadhu replied",
  chatAnswerReadyBody: "Your answer is ready.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "New message",
  proactiveNewMessageToast: "Sadhu has a new message for you.",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Open",
}
