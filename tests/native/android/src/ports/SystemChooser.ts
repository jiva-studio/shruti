/** The system's share / open-with chooser — an activity that belongs to the OS. */
export interface SystemChooser {
  isOpen(): Promise<boolean>
  waitUntilOpen(timeoutMs?: number): Promise<void>
  waitUntilClosed(timeoutMs?: number): Promise<void>
}
