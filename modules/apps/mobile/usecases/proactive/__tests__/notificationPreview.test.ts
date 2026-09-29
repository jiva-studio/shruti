import { describe, expect, it } from "vitest"
import { toNotificationPreview } from "../notificationPreview.js"

describe("toNotificationPreview", () => {
  it("strips action markers", () => {
    expect(toNotificationPreview("Keep going in order. [action:queue_next_track|id=main]")).toBe(
      "Keep going in order."
    )
  })

  it("strips cite and footnote markers", () => {
    expect(toNotificationPreview("Here is a digest.\n[^1]\n[cite:track_5@0-12|A talk]")).toBe(
      "Here is a digest."
    )
  })

  it("strips leaked sentence markers", () => {
    expect(toNotificationPreview("Nice rhythm this week. [s=0,1]")).toBe("Nice rhythm this week.")
  })

  it("strips the weekly-digest card marker, keeping the intro line", () => {
    expect(toNotificationPreview("Here's how your week went 🙏\n\n[digest:1000-2000]")).toBe(
      "Here's how your week went 🙏"
    )
  })

  it("drops markdown punctuation and collapses whitespace", () => {
    expect(toNotificationPreview("# Weekly progress\n\n**Great** week!")).toBe(
      "Weekly progress Great week!"
    )
  })

  it("truncates long text with an ellipsis", () => {
    const long = "word ".repeat(50).trim()
    const out = toNotificationPreview(long, 20)
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.endsWith("…")).toBe(true)
  })

  it("returns empty string when nothing meaningful remains", () => {
    expect(toNotificationPreview("[action:queue_next_track|id=main]")).toBe("")
    expect(toNotificationPreview("   ")).toBe("")
  })
})
