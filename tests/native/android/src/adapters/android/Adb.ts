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

  /**
   * Run one command as root — the only way to set the clock or the timezone.
   * `su` rather than `adb root`: restarting adbd drops every forward and
   * reverse of the run (Appium's channel to the UiAutomator2 server and the
   * mock server's reverse included), and the next command races the restart
   * often enough to leave the device offline mid-spec.
   */
  rootShell(command: string): string {
    return this.shell(`su 0 ${command}`)
  }

  get component(): string {
    return `${this.target.appPackage}/${this.target.mainActivity}`
  }

  get appPackage(): string {
    return this.target.appPackage
  }
}
