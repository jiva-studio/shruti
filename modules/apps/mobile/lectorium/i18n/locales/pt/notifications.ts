export default {
  enableDailyNotifications:
    "Ative os lembretes. Eles ajudam você a manter sua sādhana e seguir inspirado.",
  timeToListen: "É hora de ouvir um sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "Faz um tempo — aulas novas estão esperando por você.",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Você não terminou “{title}”. Toque para voltar e concluir.",
}
