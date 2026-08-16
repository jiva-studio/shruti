export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "G",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "D",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Lecture",
  /** …and while it is playing. */
  pause: "Pause",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Conférence terminée",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Reculer de {seconds} secondes",
    /** Accessible name of the seek-forwards button. */
    forward: "Avancer de {seconds} secondes",
  },
}
