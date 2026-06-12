export default {
  enableDailyNotifications:
    "Kapcsold be az emlékeztetőket. Segítenek fenntartani a szádhanádat és inspiráltnak maradni.",
  timeToListen: "Itt az idő, hogy egy szádhut hallgass!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Néhány napja nem jártál itt — friss előadások várnak rád.",
  proactiveInactivityBody7: "Egy hét telt el előadás nélkül. Térj vissza, és folytassuk együtt.",
  proactiveInactivityBody14:
    "Két hete nem jártál itt. A gyakorlásod hiányol — koppints a visszatéréshez.",
  proactiveInactivityBody30:
    "Eltelt egy egész hónap. Egyetlen koppintással visszatérhetsz a ritmusba.",
  proactiveInactivityBody60: "Régen jártál itt. Talán itt az ideje visszatérni az előadásokhoz?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody:
    "Nem fejezted be a(z) „{title}” előadást. Koppints, hogy visszatérj és befejezd.",
}
