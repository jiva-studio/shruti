// @vitest-environment jsdom
/**
 * The heatmap's whole job is to give a day a shade the reader can compare with
 * the day next to it, so the thresholds between shades, and the ring around
 * today, are the behaviour.
 */
import { afterEach, describe, expect, it } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import ActivityHeatmap from "../ActivityHeatmap.vue"
import type { ActivityHeatmapDay } from "../ActivityHeatmap.types.js"

type HeatmapProps = InstanceType<typeof ActivityHeatmap>["$props"]

const MINUTE = 60

function day(listenedSeconds: number, over: Partial<ActivityHeatmapDay> = {}): ActivityHeatmapDay {
  return { date: "2026-01-01", listenedSeconds, isToday: false, ...over }
}

let app: App | null = null

function render(props: HeatmapProps): HTMLElement {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(defineComponent({ setup: () => () => h(ActivityHeatmap, props) }))
  app.mount(host)
  return host
}

const fills = (host: HTMLElement): (string | null)[] =>
  Array.from(host.querySelectorAll("rect")).map((r) => r.getAttribute("fill"))

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

describe("ActivityHeatmap shades", () => {
  it("leaves a day with nothing listened blank", () => {
    const host = render({ days: [day(0)] })

    expect(fills(host)).toEqual(["var(--heatmap-empty)"])
  })

  it("darkens a day by band as the listening grows", () => {
    const host = render({
      days: [day(1), day(15 * MINUTE), day(60 * MINUTE), day(120 * MINUTE)],
    })

    expect(fills(host)).toEqual([
      "var(--heatmap-listened-1)",
      "var(--heatmap-listened-2)",
      "var(--heatmap-listened-3)",
      "var(--heatmap-listened-4)",
    ])
  })

  it("keeps a day just under a threshold in the lower band", () => {
    const host = render({
      days: [day(15 * MINUTE - 1), day(60 * MINUTE - 1), day(120 * MINUTE - 1)],
    })

    expect(fills(host)).toEqual([
      "var(--heatmap-listened-1)",
      "var(--heatmap-listened-2)",
      "var(--heatmap-listened-3)",
    ])
  })

  it("does not darken past the top band, however long the day was", () => {
    const host = render({ days: [day(120 * MINUTE), day(24 * 60 * MINUTE)] })

    expect(fills(host)).toEqual(["var(--heatmap-listened-4)", "var(--heatmap-listened-4)"])
  })

  it("treats a negative total as nothing listened rather than as a shade", () => {
    const host = render({ days: [day(-30)] })

    expect(fills(host)).toEqual(["var(--heatmap-empty)"])
  })
})

describe("ActivityHeatmap grid", () => {
  it("rings today, and only today", () => {
    const host = render({ days: [day(0), day(30 * MINUTE, { isToday: true }), day(0)] })
    const rects = Array.from(host.querySelectorAll("rect"))

    expect(rects.map((r) => r.getAttribute("stroke"))).toEqual([
      "none",
      "var(--ion-color-primary)",
      "none",
    ])
    expect(rects[1].getAttribute("stroke-width")).toBe("2")
  })

  it("lays the days out a week per column", () => {
    const host = render({ days: Array.from({ length: 21 }, () => day(0)) })
    const rects = Array.from(host.querySelectorAll("rect"))

    expect(rects).toHaveLength(21)
    // Seven cells of 10px on a 12px step fill one column before the next starts.
    expect(rects[6].getAttribute("x")).toBe("0")
    expect(rects[6].getAttribute("y")).toBe("72")
    expect(rects[7].getAttribute("x")).toBe("12")
    expect(rects[7].getAttribute("y")).toBe("0")
  })

  it("follows a row count the caller asked for", () => {
    const host = render({ days: Array.from({ length: 6 }, () => day(0)), rows: 3 })
    const rects = Array.from(host.querySelectorAll("rect"))

    expect(rects[3].getAttribute("x")).toBe("12")
    expect(rects[3].getAttribute("y")).toBe("0")
  })

  it("renders an empty grid rather than failing when there is no history", () => {
    const host = render({ days: [] })

    expect(host.querySelectorAll("rect")).toHaveLength(0)
    expect(host.querySelector("svg")).not.toBeNull()
  })
})
