import type { Telephony } from "../../ports/Telephony.js"
import type { Adb } from "./Adb.js"

export class EmulatorTelephony implements Telephony {
  constructor(
    private readonly adb: Adb,
    private readonly number = "5551234",
  ) {}

  async incomingCall(): Promise<void> {
    this.adb.emu("gsm", "call", this.number)
  }

  async endCall(): Promise<void> {
    this.adb.emu("gsm", "cancel", this.number)
  }
}
