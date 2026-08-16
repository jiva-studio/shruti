export default {
  mix: {
    /** Left-channel marker on the stereo mix slider — "L" for "Left". */
    left: "B",
    /** Right-channel marker on the stereo mix slider — "R" for "Right". */
    right: "J",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Lejátszás",
  /** …and while it is playing. */
  pause: "Szünet",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Az előadás meghallgatva",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "{seconds} másodperccel vissza",
    /** Accessible name of the seek-forwards button. */
    forward: "{seconds} másodperccel előre",
  },
}
