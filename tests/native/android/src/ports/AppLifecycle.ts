export enum AppState {
  NotInstalled = 0,
  NotRunning = 1,
  Background = 3,
  Foreground = 4,
}

export interface RunningService {
  readonly name: string
  readonly foreground: boolean
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
  /** The Recents swipe: the task goes, the process and its services may not. */
  removeFromRecents(): Promise<void>
  /** How many tasks the system holds for the app — a relaunch must not add one. */
  taskCount(): Promise<number>
  runningServices(): Promise<RunningService[]>
  measureColdStart(): Promise<{ totalMs: number }>
}
