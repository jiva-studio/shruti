import { App } from "@capacitor/app"
import type { IAppLifecycle } from "@ports/app/index.js"

/** {@link IAppLifecycle} over `@capacitor/app`, which answers on web as well. */
export function useCapacitorAppLifecycle(): IAppLifecycle {
  return {
    onStateChange: (listener) =>
      App.addListener("appStateChange", (state) => listener({ isActive: state.isActive })),
    getState: async () => ({ isActive: (await App.getState()).isActive }),
  }
}
