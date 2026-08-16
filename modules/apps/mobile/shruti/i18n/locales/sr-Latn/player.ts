export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "L",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "D",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Pusti",
  /** …and while it is playing. */
  pause: "Pauza",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Predavanje odslušano",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Nazad {seconds} sekundi",
    /** Accessible name of the seek-forwards button. */
    forward: "Napred {seconds} sekundi",
  },
}
