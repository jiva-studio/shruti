export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "E",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "D",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Reproduzir",
  /** …and while it is playing. */
  pause: "Pausar",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Palestra concluída",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Voltar {seconds} segundos",
    /** Accessible name of the seek-forwards button. */
    forward: "Avançar {seconds} segundos",
  },
}
