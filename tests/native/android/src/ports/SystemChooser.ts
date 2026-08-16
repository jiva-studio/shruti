/** The system's share / open-with chooser — an activity that belongs to the OS. */
export interface SystemChooser {
  isOpen(): Promise<boolean>
  waitUntilOpen(timeoutMs?: number): Promise<void>
  waitUntilClosed(timeoutMs?: number): Promise<void>
  /** Whether what the chooser was handed carries read access to the sender's content. */
  grantsReadAccess(): Promise<boolean>
  /** The sender's `content://` URIs the system currently holds a read grant for. */
  sharedUris(): Promise<string[]>
}
