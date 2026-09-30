// Known violation: a rejected promise dropped without a word.
export function playQuietly(play: () => Promise<void>): void {
  void play().catch(() => {})
}

export function pauseQuietly(pause: () => Promise<void>): void {
  void pause().then(undefined, function () {})
}
