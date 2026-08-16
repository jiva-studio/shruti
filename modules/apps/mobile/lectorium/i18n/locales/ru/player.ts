export default {
  mix: {
    /** Левый канал — отметка слева на слайдере стерео-микса. */
    left: "Л",
    /** Правый канал — отметка справа на слайдере стерео-микса. */
    right: "П",
  },

  /** Accessible name of the floating player's main control while paused. */
  play: "Воспроизвести",
  /** …and while it is playing. */
  pause: "Пауза",
  /** …and once the lecture has been listened to (the control is inert). */
  completed: "Лекция прослушана",
  skip: {
    /** Accessible name of the seek-backwards button. */
    back: "Назад на {seconds} секунд",
    /** Accessible name of the seek-forwards button. */
    forward: "Вперёд на {seconds} секунд",
  },
}
