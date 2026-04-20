import { toastController } from "@ionic/vue"

/**
 * Single entry point for user-facing ephemeral messages.
 *
 * Wrapped here (not inline at call-sites) so the duration / position /
 * colour stay consistent across the app — the legacy app used a custom
 * stacking deck; Ionic's single-toast controller is the simplest
 * equivalent and good enough for this surface.
 */

export interface ToastOptions {
  readonly durationMs?: number
}

const DEFAULT_DURATION = 1800

async function present(message: string, color: "primary" | "danger", opts?: ToastOptions): Promise<void> {
  const toast = await toastController.create({
    message,
    duration: opts?.durationMs ?? DEFAULT_DURATION,
    position: "top",
    color,
  })
  await toast.present()
}

export function useToast() {
  return {
    info(message: string, opts?: ToastOptions): Promise<void> {
      return present(message, "primary", opts)
    },
    error(message: string, opts?: ToastOptions): Promise<void> {
      return present(message, "danger", opts)
    },
  }
}
