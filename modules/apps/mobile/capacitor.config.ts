import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "studio.jiva.shruti",
  appName: "shruti",
  webDir: "dist",
  // TODO: don't use this in production
  server: {
    cleartext: true,
    androidScheme: "http",
  },
}
export default config
