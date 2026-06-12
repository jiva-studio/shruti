export default {
  enableDailyNotifications:
    "Ative os lembretes. Eles ajudam você a manter sua sādhana e seguir inspirado.",
  timeToListen: "É hora de ouvir um sadhu!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "Faz alguns dias — aulas novas estão esperando por você.",
  proactiveInactivityBody7: "Uma semana sem nenhuma aula. Volte e vamos continuar.",
  proactiveInactivityBody14: "Duas semanas longe. Sua prática sente sua falta — toque para voltar.",
  proactiveInactivityBody30: "Já passou um mês inteiro. Um toque e você volta ao ritmo.",
  proactiveInactivityBody60: "Faz muito tempo. Talvez seja hora de voltar às aulas?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "Você não terminou “{title}”. Toque para voltar e concluir.",
}
