export default {
  enableDailyNotifications:
    "अनुस्मारक चालू करें। ये आपको अपनी साधना बनाए रखने और प्रेरित रहने में मदद करेंगे।",
  timeToListen: "साधु को सुनने का समय है!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody3: "कुछ दिन हो गए — ताज़ा प्रवचन आपका इंतज़ार कर रहे हैं।",
  proactiveInactivityBody7: "एक सप्ताह बिना किसी प्रवचन के बीत गया। लौट आइए, चलिए आगे बढ़ें।",
  proactiveInactivityBody14:
    "दो सप्ताह हो गए। आपकी साधना आपको याद कर रही है — लौटने के लिए टैप करें।",
  proactiveInactivityBody30: "पूरा एक महीना बीत गया। एक टैप आपको फिर उसी लय में ले आएगा।",
  proactiveInactivityBody60: "काफ़ी समय हो गया। शायद अब प्रवचनों पर लौटने का समय है?",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "आपने “{title}” पूरा नहीं किया। लौटकर इसे पूरा करने के लिए टैप करें।",
  // Shown when a chat answer finishes while the app is backgrounded (or armed
  // ahead at send in case the app freezes mid-turn). The title carries the
  // session's own title when there is one (so multiple chats are
  // distinguishable); this generic title is the fallback.
  chatAnswerReadyTitle: "साधु ने उत्तर दिया",
  chatAnswerReadyBody: "आपका उत्तर तैयार है।",
  // Toast shown when a proactive message appears while the app is in the
  // foreground. Title is the fallback toast header for sessions without
  // their own title.
  proactiveNewMessageTitle: "नया संदेश",
  proactiveNewMessageToast: "साधु के पास आपके लिए एक नया संदेश है।",
  // Action button on the in-app toast — opens the chat session.
  openButton: "खोलें",
}
