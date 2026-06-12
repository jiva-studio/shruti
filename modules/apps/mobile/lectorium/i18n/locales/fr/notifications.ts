export default {
  enableDailyNotifications:
    "Activez les rappels. Ils vous aideront à maintenir votre sādhana et à rester inspiré.",
  timeToListen: "Il est temps d'écouter un sadhu !",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  // Escalating re-engagement copy, picked by how many days the user has
  // been away (3 / 7 / 14 / 30 / 60), from a gentle nudge to a final one.
  proactiveInactivityBody3: "Cela fait quelques jours — de nouvelles conférences vous attendent.",
  proactiveInactivityBody7: "Une semaine sans conférence. Revenez, continuons ensemble.",
  proactiveInactivityBody14:
    "Deux semaines d'absence. Votre pratique vous attend — appuyez pour revenir.",
  proactiveInactivityBody30:
    "Un mois entier s'est écoulé. Un seul geste vous ramène dans le rythme.",
  proactiveInactivityBody60:
    "Cela fait bien longtemps. Et si c'était le moment de revenir aux conférences ?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody:
    "Vous n'avez pas terminé « {title} ». Appuyez pour reprendre et la terminer.",
}
