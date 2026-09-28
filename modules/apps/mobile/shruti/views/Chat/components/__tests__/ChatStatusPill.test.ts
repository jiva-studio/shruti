// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h } from "vue"
import type { ResearchSourceKind } from "@lib/contracts"

const seen = vi.hoisted(() => ({ sources: undefined as ReadonlyMap<string, unknown> | undefined }))

vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ setup: () => () => h("span") }),
}))
vi.mock("@lib/ui/chat/StatusPill.vue", () => ({
  default: defineComponent({
    props: { statusLabel: String, researchQuestions: Array, researchSources: Map },
    setup(props) {
      return () => {
        seen.sources = props.researchSources as ReadonlyMap<string, unknown> | undefined
        return h("div")
      }
    },
  }),
}))

const { default: ChatStatusPill } = await import("../ChatStatusPill.vue")

let host: HTMLElement | null = null
function mount(sources?: ReadonlyMap<string, { sourceKind: ResearchSourceKind; label: string }>) {
  host = document.createElement("div")
  createApp(ChatStatusPill, { researchSources: sources }).mount(host)
}

describe("ChatStatusPill", () => {
  afterEach(() => {
    host = null
    seen.sources = undefined
  })

  it("keeps the app's phase-3 output: commentary and media sources are not shown", () => {
    mount(
      new Map<string, { sourceKind: ResearchSourceKind; label: string }>([
        ["verse:1", { sourceKind: "verse", label: "BG 2.13" }],
        ["lecture:t:0", { sourceKind: "lecture_chunk", label: "Talk" }],
        ["library:2", { sourceKind: "library_doc", label: "Letter" }],
        ["library:3", { sourceKind: "commentary", label: "Purport" }],
        ["media:4", { sourceKind: "media", label: "Video" }],
      ])
    )
    expect([...seen.sources!.keys()]).toEqual(["verse:1", "lecture:t:0", "library:2"])
  })

  it("passes no sources through when there are none", () => {
    mount(undefined)
    expect(seen.sources).toBeUndefined()
  })
})
