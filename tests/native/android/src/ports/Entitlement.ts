export type Tier = "pro" | "free" | "default"

/** The tier the app runs as. Honoured only by builds made for tests. */
export interface Entitlement {
  set(tier: Tier): Promise<void>
}
