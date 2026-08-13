export enum AppState {
  NotInstalled = 0,
  NotRunning = 1,
  Background = 3,
  Foreground = 4,
}

export interface AppLifecycle {
  currentActivity(): Promise<string>
  state(): Promise<AppState>
  launch(): Promise<void>
  forceStop(): Promise<void>
  restart(): Promise<void>
  sendToBackground(seconds: number): Promise<void>
  leaveInBackground(): Promise<void>
  returnToForeground(): Promise<void>
  /** `am kill` reaps only a backgrounded process — how the system reclaims one. */
  killWhileBackgrounded(): Promise<void>
  /** How many tasks the system holds for the app — a relaunch must not add one. */
  taskCount(): Promise<number>
  measureColdStart(): Promise<{ totalMs: number }>
}
