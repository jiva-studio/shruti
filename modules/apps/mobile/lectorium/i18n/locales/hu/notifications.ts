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
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Sadhu válaszolt",
  chatAnswerReadyBody: "A válaszod elkészült.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Új üzenet",
  proactiveNewMessageToast: "Sadhunak új üzenete van számodra.",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Megnyitás",
}
