import { toastController } from "@ionic/vue"

/**
 * Thin wrapper over Ionic's single-toast controller for user-facing
 * ephemeral messages. kit owns no i18n: the caller passes already-translated
 * text. Duration / position / colour stay parametrizable so each app can
 * keep them consistent across its own call-sites.
 */

export type ToastColor = "primary" | "secondary" | "tertiary" | "success" | "warning" | "danger"

export type ToastPosition = "top" | "bottom" | "middle"

/** Ionic's button layout: inline with the message, or on a line of their own. */
export type ToastLayout = "baseline" | "stacked"

/**
 * What to do about a toast that is already on screen. Ionic's overlay
 * controller is not a queue — without a policy two toasts render as a pile.
 */
export type ToastPolicy =
  /**
   * Dismiss the live toast (role `"replaced"`) and present at once — unless it
   * carries buttons, which is an unanswered question and is waited out.
   */
  | "replace"
  /** Wait for the live toast to go away, and stay put while a later one waits. */
  | "queue"

export interface ToastOptions {
  /** Auto-dismiss after this many ms. */
  readonly durationMs?: number
  /** Where the toast appears. */
  readonly position?: ToastPosition
  /** Ionic colour token. */
  readonly color?: ToastColor
  /** How to treat a toast already on screen (default `"replace"`). */
  readonly policy?: ToastPolicy
}

/** A button rendered inside the toast. `text` is already translated. */
export interface ToastButton {
  /** Button label. */
  readonly text: string
  /** Ionic role, echoed back in the outcome. `"cancel"` skips the handler's veto. */
  readonly role?: string
  /** Which side of the message the button sits on (Ionic default: `"end"`). */
  readonly side?: "start" | "end"
  /** Runs on press, before the toast leaves. Returning `false` keeps it open. */
  readonly handler?: () => boolean | void | Promise<boolean | void>
}

export interface ToastActionOptions extends ToastOptions {
  /** At least one button; presenting an actionable toast without one is pointless. */
  readonly buttons: readonly ToastButton[]
  /** Button layout (default `"stacked"`: a translated label needs the whole row). */
  readonly layout?: ToastLayout
}

/** How an actionable toast ended. */
export type ToastOutcome =
  /** A button was pressed; `index` points into the `buttons` array passed in. */
  | { readonly kind: "pressed"; readonly index: number; readonly role?: string }
  /** The duration ran out with no press. */
  | { readonly kind: "expired" }
  /**
   * Swiped away, dismissed programmatically, or closed by any other route.
   * Never by a newer toast: an actionable toast holds the screen until it is
   * answered or expires.
   */
  | { readonly kind: "dismissed"; readonly role?: string }

export interface UseToast {
  /** Present a toast with the given (already-translated) message. */
  show(message: string, opts?: ToastOptions): Promise<void>
  /** Present an informational toast (default colour `primary`). */
  info(message: string, opts?: ToastOptions): Promise<void>
  /** Present an error toast (default colour `danger`). */
  error(message: string, opts?: ToastOptions): Promise<void>
  /**
   * Present a toast carrying buttons and resolve once it goes away, reporting
   * whether a button was pressed, the duration expired, or it was dismissed.
   * Unlike `show` / `info` / `error`, which resolve as soon as the toast is on
   * screen, this awaits the dismissal.
   */
  action(message: string, opts: ToastActionOptions): Promise<ToastOutcome>
}

const DEFAULT_DURATION = 1800
/** Errors and actionable toasts carry an instruction to read, not a confirmation to glance at. */
const DEFAULT_INSTRUCTIONAL_DURATION = 4000
const DEFAULT_POSITION: ToastPosition = "top"
const DEFAULT_POLICY: ToastPolicy = "replace"
const REPLACED_ROLE = "replaced"

type ToastElement = Awaited<ReturnType<typeof toastController.create>>

interface LiveToast {
  readonly element: ToastElement
  readonly dismissed: Promise<unknown>
  /**
   * Queued toasts, and toasts collecting an answer, are not replaced: a later
   * one waits for them instead. A prompt the user never got to answer is a
   * feature they cannot reach, so status noise must not take its screen.
   */
  readonly held: boolean
}

// The screen is a single slot, so the policy state is module-wide, shared by
// every `useToast()` instance.
let live: LiveToast | undefined
let chain: Promise<unknown> = Promise.resolve()

/** Runs presentations one at a time, in call order. */
function serialize<T>(run: () => Promise<T>): Promise<T> {
  const next = chain.then(run, run)
  chain = next.then(
    () => undefined,
    () => undefined
  )
  return next
}

async function makeRoom(policy: ToastPolicy): Promise<void> {
  const current = live
  if (!current) return
  if (policy === "queue" || current.held) await current.dismissed
  else await current.element.dismiss(undefined, REPLACED_ROLE)
  if (live === current) live = undefined
}

async function takeScreen(
  create: () => Promise<ToastElement>,
  policy: ToastPolicy,
  holdsAnswer = false
): Promise<{ toast: ToastElement; dismissed: Promise<{ role?: string }> }> {
  await makeRoom(policy)
  const toast = await create()
  const dismissed = toast.onDidDismiss()
  const entry: LiveToast = { element: toast, dismissed, held: policy === "queue" || holdsAnswer }
  live = entry
  void dismissed.then(
    () => {
      if (live === entry) live = undefined
    },
    () => {
      if (live === entry) live = undefined
    }
  )
  await toast.present()
  return { toast, dismissed }
}

/**
 * Returns a toast presenter. `defaults` set the baseline duration / position /
 * colour / policy; per-call `opts` override them.
 */
export function useToast(defaults: ToastOptions = {}): UseToast {
  function baseOptions(opts: ToastOptions | undefined, fallbackDuration: number) {
    return {
      duration: opts?.durationMs ?? defaults.durationMs ?? fallbackDuration,
      position: opts?.position ?? defaults.position ?? DEFAULT_POSITION,
      color: opts?.color ?? defaults.color,
      swipeGesture: "vertical" as const,
    }
  }

  function policyOf(opts: ToastOptions | undefined): ToastPolicy {
    return opts?.policy ?? defaults.policy ?? DEFAULT_POLICY
  }

  async function present(
    message: string,
    opts?: ToastOptions,
    fallbackDuration: number = DEFAULT_DURATION
  ): Promise<void> {
    await serialize(() =>
      takeScreen(
        () => toastController.create({ message, ...baseOptions(opts, fallbackDuration) }),
        policyOf(opts)
      )
    )
  }

  async function action(message: string, opts: ToastActionOptions): Promise<ToastOutcome> {
    // Ionic reports the dismissal role, but a button without a role dismisses
    // with `role: undefined` — indistinguishable from a programmatic dismiss.
    // Wrapping each handler records the press itself.
    let pressed: { index: number; role?: string } | undefined
    const buttons = opts.buttons.map((button, index) => ({
      text: button.text,
      role: button.role,
      side: button.side,
      handler: () => {
        pressed = { index, role: button.role }
        return button.handler?.()
      },
    }))

    const { dismissed } = await serialize(() =>
      takeScreen(
        () =>
          toastController.create({
            message,
            buttons,
            layout: opts.layout ?? "stacked",
            ...baseOptions(opts, DEFAULT_INSTRUCTIONAL_DURATION),
          }),
        policyOf(opts),
        true
      )
    )
    const { role } = await dismissed

    if (pressed) return { kind: "pressed", index: pressed.index, role: pressed.role }
    if (role === "timeout") return { kind: "expired" }
    return { kind: "dismissed", role }
  }

  return {
    show(message, opts) {
      return present(message, opts)
    },
    info(message, opts) {
      return present(message, { color: "primary", ...opts })
    },
    error(message, opts) {
      return present(message, { color: "danger", ...opts }, DEFAULT_INSTRUCTIONAL_DURATION)
    },
    action,
  }
}
