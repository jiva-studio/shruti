export default {
  enableDailyNotifications:
    "অনুস্মারক চালু করুন। এগুলো আপনাকে সাধনা বজায় রাখতে ও অনুপ্রাণিত থাকতে সাহায্য করবে।",
  timeToListen: "সাধু শোনার সময় হয়েছে!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "কয়েক দিন হয়ে গেল — নতুন লেকচার আপনার জন্য অপেক্ষা করছে।",
  proactiveInactivityBody7: "একটি সপ্তাহ লেকচার ছাড়াই কেটে গেল। ফিরে আসুন, আমরা আবার শুরু করি।",
  proactiveInactivityBody14: "দুই সপ্তাহ দূরে। আপনার সাধনা আপনাকে মিস করছে — ফিরতে ট্যাপ করুন।",
  proactiveInactivityBody30: "পুরো একটি মাস কেটে গেল। একটি ট্যাপেই আবার ছন্দে ফিরে আসুন।",
  proactiveInactivityBody60: "অনেকদিন হয়ে গেল। হয়তো এখন লেকচারে ফিরে আসার সময় হয়েছে?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "আপনি “{title}” শেষ করেননি। ফিরে গিয়ে শেষ করতে ট্যাপ করুন।",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback. No "tap to…" hint —
  // tapping is the only possible action, so it adds nothing.
  chatAnswerReadyTitle: "সাধু উত্তর দিয়েছেন",
  chatAnswerReadyBody: "আপনার উত্তর প্রস্তুত।",
  // Toast shown when a proactive message appears while the app is in the
  // foreground (its background delivery is a separate scheduled notification).
  // Title is the fallback toast header for sessions without their own title.
  proactiveNewMessageTitle: "নতুন বার্তা",
  proactiveNewMessageToast: "সাধুর কাছে আপনার জন্য একটি নতুন বার্তা আছে।",
  proactiveNewMessagesTitle: "নতুন বার্তা",
  proactiveNewMessagesToast: "সাধুর কাছে আপনার জন্য নতুন বার্তা আছে ({count})।",
  // Action button on the in-app toast — opens the chat session.
  openButton: "খুলুন",
}
