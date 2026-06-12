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
}
