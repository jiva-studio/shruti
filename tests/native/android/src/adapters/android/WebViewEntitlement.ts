import type { Entitlement, Tier } from "../../ports/Entitlement.js"
import type { WebView } from "./WebView.js"

const KEY = "CapacitorStorage.dev.subscriptionOverride"

export class WebViewEntitlement implements Entitlement {
  constructor(private readonly webView: WebView) {}

  async set(tier: Tier): Promise<void> {
    await this.webView.enter()
    await browser.execute(
      (key: string, value: string) => {
        if (value === "default") localStorage.removeItem(key)
        else localStorage.setItem(key, value)
      },
      KEY,
      tier,
    )
  }
}
