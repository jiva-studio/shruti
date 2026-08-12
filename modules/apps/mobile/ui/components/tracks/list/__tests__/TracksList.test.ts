// @vitest-environment jsdom
/** Qase case 335. */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, type App } from "vue"
import type { UiTrackRow } from "../types.js"

/* -- Module doubles ---------------------------------------------------- */

const stub = (tag: string, name: string) =>
  defineComponent({
    name,
    setup:
      (_props, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })

vi.mock("@ionic/vue", () => ({
  IonList: stub("ion-list", "IonList"),
  IonItem: stub("ion-item", "IonItem"),
  IonLabel: stub("ion-label", "IonLabel"),
}))
vi.mock("../TrackListItem.vue", () => ({ default: stub("track-row", "TrackListItem") }))
vi.mock("@ui/components/RowDivider.vue", () => ({ default: stub("row-divider", "RowDivider") }))

const { default: TracksList } = await import("../TracksList.vue")

/* -- Harness ----------------------------------------------------------- */

let app: App | null = null
let host: HTMLElement | null = null

function render(props: { rows: readonly UiTrackRow[]; emptyMessage?: string }): HTMLElement {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(TracksList, props)
  app.mount(host)
  return host
}

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

function row(id: string): UiTrackRow {
  return {
    id,
    title: `Lecture ${id}`,
    author: "",
    location: "",
    date: "",
    references: [],
    tags: [],
    state: "none",
    progressPct: 0,
    disabled: false,
    dimmed: false,
  }
}

/* -- Cases ------------------------------------------------------------- */

describe("TracksList, with no rows", () => {
  it("renders no row at all when the caller passed no message", () => {
    // The bug: a blank full-height item that reads as content the list does
    // not have. Every caller today passes no `emptyMessage`.
    const el = render({ rows: [] })
    expect(el.querySelectorAll("ion-item")).toHaveLength(0)
    expect(el.textContent?.trim()).toBe("")
  })

  it("still renders the message row for a caller that has something to say", () => {
    const el = render({ rows: [], emptyMessage: "Nothing here yet" })
    expect(el.querySelectorAll("ion-item")).toHaveLength(1)
    expect(el.textContent).toContain("Nothing here yet")
  })
})

describe("TracksList, with rows", () => {
  it("renders the rows and no empty item", () => {
    const el = render({ rows: [row("a"), row("b")] })
    expect(el.querySelectorAll("track-row")).toHaveLength(2)
    expect(el.querySelectorAll("ion-item")).toHaveLength(0)
  })
})
