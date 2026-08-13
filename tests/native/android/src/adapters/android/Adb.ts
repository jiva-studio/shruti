import { execFileSync } from "node:child_process"

export interface AppTarget {
  readonly serial: string
  readonly appPackage: string
  readonly mainActivity: string
}

/** Thin transport shared by the Android adapters. */
export class Adb {
  constructor(readonly target: AppTarget) {}

  exec(...args: string[]): string {
    return execFileSync("adb", ["-s", this.target.serial, ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    })
  }

  shell(command: string): string {
    return this.exec("shell", command)
  }

  emu(...args: string[]): string {
    return this.exec("emu", ...args)
  }

  get component(): string {
    return `${this.target.appPackage}/${this.target.mainActivity}`
  }

  get appPackage(): string {
    return this.target.appPackage
  }
}
