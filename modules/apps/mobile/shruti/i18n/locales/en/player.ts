export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "L",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "R",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Play",
  /** …and while it is playing. */
  pause: "Pause",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Lecture finished",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Skip back {seconds} seconds",
    /** Accessible name of the seek-forwards button. */
    forward: "Skip forward {seconds} seconds",
  },
}
