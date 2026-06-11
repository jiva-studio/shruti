export default {
  enableDailyNotifications:
    "Kapcsold be az emlékeztetőket. Segítenek fenntartani a szádhanádat és inspiráltnak maradni.",
  timeToListen: "Itt az idő, hogy egy szádhut hallgass!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Rég jártál itt — friss előadások várnak rád.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Nem fejezted be a(z) „{title}” előadást. Koppints, hogy visszatérj és befejezd.",
}
