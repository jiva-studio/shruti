// AUTO-GENERATED from ../sr-Latn by modules/tools/sr-transliterate/generate-sr-cyrl.mjs
// Do not edit by hand — re-run the generator instead.
export default {
  enableDailyNotifications:
    "Укључите подсетнике. Помоћи ће вам да одржите своју садхану и останете надахнути.",
  timeToListen: "Време је да слушате садхуа!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Прошло је неколико дана — свежа предавања вас чекају.",
  proactiveInactivityBody7: "Недељу дана без предавања. Вратите се и наставимо.",
  proactiveInactivityBody14:
    "Две недеље вас нема. Ваша пракса вам недостаје — додирните да се вратите.",
  proactiveInactivityBody30: "Прошао је цео месец. Један додир враћа вас у ток.",
  proactiveInactivityBody60: "Дуго вас није било. Можда је време да се вратите предавањима?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Нисте довршили „{title}“. Додирните да се вратите и завршите.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "Садху је одговорио",
  chatAnswerReadyBody: "Ваш одговор је спреман.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Нова порука",
  proactiveNewMessageToast: "Садху има нову поруку за вас.",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Отвори",
}
