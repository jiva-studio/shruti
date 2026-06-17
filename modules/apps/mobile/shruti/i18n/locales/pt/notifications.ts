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
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "O Sadhu respondeu",
  chatAnswerReadyBody: "Sua resposta está pronta.",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "Nova mensagem",
  proactiveNewMessageToast: "O Sadhu tem uma nova mensagem para você.",
  // Action button on the in-app toast — opens the chat session.
  openButton: "Abrir",
}
