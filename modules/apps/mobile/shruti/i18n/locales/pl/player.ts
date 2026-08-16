export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "L",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "P",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Odtwórz",
  /** …and while it is playing. */
  pause: "Pauza",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Wykład wysłuchany",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Cofnij o {seconds} sekund",
    /** Accessible name of the seek-forwards button. */
    forward: "Przewiń o {seconds} sekund",
  },
}
