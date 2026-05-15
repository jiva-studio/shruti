export interface LabelStep {
  /** Wall-clock offset from the start of the wrapped task, in ms. */
  readonly atMs: number
  /** Label to display once `atMs` has elapsed. */
  readonly label: string
}

/**
 * Run `task`. While it pends, on every tick (default 1s) call
 * `setLabel(step.label)` for the highest-`atMs` step that has elapsed.
 * Stop ticking when `task` settles (success or rejection). Always
 * returns the task's result; never swallows errors.
 *
 * Why: AWS share-video and YC share-video have different latency profiles
 * (1s vs 120s for the cut call). Tying loading-modal labels to where I/O
 * happens — poll ticks vs response landing — would make the AWS spinner
 * progressive and the YC spinner frozen for 2 minutes. With this helper
 * the labels advance on a wall clock regardless, so both clouds look the
 * same to the user.
 *
 * Schedule MUST be sorted ascending by `atMs`. The very first label (the
 * one passed to `withLoading(message, ...)`) is the implicit `atMs: 0`
 * entry; this helper only fires labels at later thresholds.
 */
export async function withProgressLabels<T>(
  task: Promise<T>,
  schedule: ReadonlyArray<LabelStep>,
  setLabel: (label: string) => void
): Promise<T> {
  const start = Date.now()
  let lastIdx = -1
  const tickMs = 1_000
  const interval = setInterval(() => {
    const elapsed = Date.now() - start
    let next = lastIdx
    for (let i = schedule.length - 1; i >= 0; i--) {
      if (schedule[i].atMs <= elapsed) {
        next = i
        break
      }
    }
    if (next !== lastIdx && next >= 0) {
      lastIdx = next
      setLabel(schedule[next].label)
    }
  }, tickMs)

  try {
    return await task
  } finally {
    clearInterval(interval)
  }
}
