export default {
  enableDailyNotifications:
    "अनुस्मारक चालू करें। ये आपको अपनी साधना बनाए रखने और प्रेरित रहने में मदद करेंगे।",
  timeToListen: "साधु को सुनने का समय है!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "काफ़ी समय हो गया — ताज़ा प्रवचन आपका इंतज़ार कर रहे हैं।",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "आपने “{title}” पूरा नहीं किया। लौटकर इसे पूरा करने के लिए टैप करें।",
}
