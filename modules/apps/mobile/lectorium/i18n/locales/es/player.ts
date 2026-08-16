export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "I",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "D",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Reproducir",
  /** …and while it is playing. */
  pause: "Pausa",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Conferencia escuchada",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Retroceder {seconds} segundos",
    /** Accessible name of the seek-forwards button. */
    forward: "Avanzar {seconds} segundos",
  },
}
