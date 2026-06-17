export default {
  enableDailyNotifications:
    "Attiva i promemoria. Ti aiuteranno a mantenere la tua sadhana e a restare ispirato.",
  timeToListen: "È ora di ascoltare un sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Sono passati alcuni giorni — nuove lezioni ti stanno aspettando.",
  proactiveInactivityBody7: "Una settimana senza una lezione. Torna e continuiamo insieme.",
  proactiveInactivityBody14:
    "Due settimane di assenza. La tua pratica ti aspetta — tocca per tornare.",
  proactiveInactivityBody30: "È passato un mese intero. Un solo tocco ti riporta nel flusso.",
  proactiveInactivityBody60: "È passato molto tempo. Forse è il momento di tornare alle lezioni?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Non hai finito “{title}”. Tocca per tornare e completarla.",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback.
  chatAnswerReadyTitle: "Sadhu ha risposto",
  chatAnswerReadyBody: "La tua risposta è pronta.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  proactiveNewMessageTitle: "Nuovo messaggio",
  proactiveNewMessageToast: "Sadhu ha un nuovo messaggio per te.",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Apri",
}
