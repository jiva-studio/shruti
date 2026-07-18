export default {
  enableDailyNotifications:
    "Activa los recordatorios. Te ayudarán a mantener tu sādhana y a seguir inspirado.",
  timeToListen: "¡Es hora de escuchar a un sādhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Han pasado unos días — te esperan clases nuevas.",
  proactiveInactivityBody7: "Una semana sin escuchar una clase. Vuelve y sigamos.",
  proactiveInactivityBody14:
    "Dos semanas sin venir. Tu práctica te echa de menos — toca para volver.",
  proactiveInactivityBody30: "Ha pasado todo un mes. Un toque te devuelve al ritmo.",
  proactiveInactivityBody60:
    "Ha pasado mucho tiempo. ¿Quizá sea el momento de volver a las clases?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "No has terminado «{title}». Toca para volver y completarla.",
  // Shown when a chat answer finishes while the app is backgrounded.
  chatAnswerReadyTitle: "Sadhu ha respondido",
  chatAnswerReadyBody: "Tu respuesta está lista.",
  // Toast shown when a proactive message appears while the app is in the foreground.
  proactiveNewMessageTitle: "Nuevo mensaje",
  proactiveNewMessageToast: "Sadhu tiene un nuevo mensaje para ti.",
  proactiveNewMessagesTitle: "Nuevos mensajes",
  proactiveNewMessagesToast: "Sadhu tiene nuevos mensajes para ti ({count}).",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Abrir",
}
