import type { Permission, Permissions } from "../../ports/Permissions.js"
import type { Adb } from "./Adb.js"

export class AndroidPermissions implements Permissions {
  constructor(private readonly adb: Adb) {}

  async grant(permission: Permission): Promise<void> {
    this.adb.shell(`pm grant ${this.adb.appPackage} android.permission.${permission}`)
  }

  async revoke(permission: Permission): Promise<void> {
    this.adb.shell(`pm revoke ${this.adb.appPackage} android.permission.${permission}`)
  }

  async isGranted(permission: Permission): Promise<boolean> {
    const dump = this.adb.shell(`dumpsys package ${this.adb.appPackage}`)
    return new RegExp(`android.permission.${permission}: granted=true`).test(dump)
  }
}
