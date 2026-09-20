import { beforeEach, describe, expect, it, vi } from "vitest"

const share = vi.fn()
const canShare = vi.fn()

vi.mock("@capacitor/share", () => ({
  Share: { share, canShare },
}))

const { useCapacitorShareService } = await import("../share/capacitorShare.js")

describe("useCapacitorShareService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("treats a dismissed sheet as done", async () => {
    const s = useCapacitorShareService()
    share.mockRejectedValue(new Error("Share canceled"))
    await expect(s.share({ url: "x" })).resolves.toBeUndefined()
    share.mockRejectedValue(new DOMException("dismissed", "AbortError"))
    await expect(s.share({ url: "x" })).resolves.toBeUndefined()
  })

  it("treats a platform without a share sheet as done", async () => {
    share.mockRejectedValue(new Error("Share API not available in this browser"))
    const s = useCapacitorShareService()
    await expect(s.share({ url: "x" })).resolves.toBeUndefined()
  })

  it("rejects when the share itself failed", async () => {
    share.mockRejectedValue(new Error("Failed to find configured root that contains /data/…"))
    const s = useCapacitorShareService()
    await expect(s.share({ url: "x" })).rejects.toThrow("Failed to find configured root")
  })

  it("reports canShare from the plugin and falls back to false on error", async () => {
    const s = useCapacitorShareService()
    canShare.mockResolvedValue({ value: true })
    expect(await s.canShare()).toBe(true)
    canShare.mockRejectedValue(new Error("no plugin"))
    expect(await s.canShare()).toBe(false)
  })

  it("writes to the clipboard via navigator.clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    const s = useCapacitorShareService()
    await s.copyToClipboard("hello")
    expect(writeText).toHaveBeenCalledWith("hello")
    vi.unstubAllGlobals()
  })
})
