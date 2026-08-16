export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "L",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "R",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Riproduci",
  /** …and while it is playing. */
  pause: "Pausa",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Lezione ascoltata",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Indietro di {seconds} secondi",
    /** Accessible name of the seek-forwards button. */
    forward: "Avanti di {seconds} secondi",
  },
}
