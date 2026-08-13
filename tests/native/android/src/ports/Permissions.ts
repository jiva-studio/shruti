export type Permission = "POST_NOTIFICATIONS" | "READ_MEDIA_AUDIO"

export interface Permissions {
  grant(permission: Permission): Promise<void>
  revoke(permission: Permission): Promise<void>
  isGranted(permission: Permission): Promise<boolean>
}
