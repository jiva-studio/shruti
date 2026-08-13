export interface SystemEvents {
  broadcast(action: string): Promise<void>
  scheduledAlarms(): Promise<number>
}
