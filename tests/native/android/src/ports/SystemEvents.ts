export interface SystemEvents {
  broadcast(action: string): Promise<void>
  /** Protected actions (AUDIO_BECOMING_NOISY, …) are refused to the shell user;
   *  only the system or root may announce them. */
  broadcastAsRoot(action: string): Promise<void>
  scheduledAlarms(): Promise<number>
}
