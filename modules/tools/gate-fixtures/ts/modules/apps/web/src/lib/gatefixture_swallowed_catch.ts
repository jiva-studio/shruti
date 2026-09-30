// Known violation: a rejected promise dropped without a word.
export function playQuietly(play: () => Promise<void>): void {
  void play().catch(() => {})
}
