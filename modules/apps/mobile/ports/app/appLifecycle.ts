/** Whether the app is in the foreground. */
export interface AppLifecycleState {
  readonly isActive: boolean
}

/** A registered lifecycle listener; `remove` detaches it. */
export interface AppLifecycleSubscription {
  remove(): Promise<void>
}

/**
 * Foreground / background transitions of the running app. Keeps the native
 * app plugin out of stores, views and composables.
 */
export interface IAppLifecycle {
  /** Called on every transition between foreground and background. */
  onStateChange(listener: (state: AppLifecycleState) => void): Promise<AppLifecycleSubscription>
  /** The state right now. */
  getState(): Promise<AppLifecycleState>
}
