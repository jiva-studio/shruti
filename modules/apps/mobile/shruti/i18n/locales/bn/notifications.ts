export default {
  enableDailyNotifications:
    "অনুস্মারক চালু করুন। এগুলো আপনাকে সাধনা বজায় রাখতে ও অনুপ্রাণিত থাকতে সাহায্য করবে।",
  timeToListen: "সাধু শোনার সময় হয়েছে!",
  // Re-engagement push fired by the `inactivity` proactive rule. It is
  // scheduled while the app is in the background, before the message
  // body exists, so the copy has to be static rather than derived.
  proactiveInactivityBody: "অনেকদিন হয়ে গেল — নতুন লেকচার আপনার জন্য অপেক্ষা করছে।",
  // Re-engagement push fired by the `unfinished_lecture` rule, scheduled
  // in the background a day after the user left a lecture unfinished.
  // `{title}` is the lecture's localised catalog title.
  unfinishedLectureBody: "আপনি “{title}” শেষ করেননি। ফিরে গিয়ে শেষ করতে ট্যাপ করুন।",
}
