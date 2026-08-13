export interface Telephony {
  incomingCall(): Promise<void>
  endCall(): Promise<void>
}
