export interface AppStorage {
  audioFiles(): Promise<string[]>
  bytesUsed(): Promise<number>
}
