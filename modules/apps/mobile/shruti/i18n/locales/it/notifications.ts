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
}
