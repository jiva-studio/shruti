export default {
  enableDailyNotifications:
    "Enable reminders. They will help you maintain your sadhana and stay inspired.",
  timeToListen: "It is time to listen to a sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "It's been a while — fresh lectures are waiting for you.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "You haven't finished “{title}”. Tap to return and complete it.",
}
