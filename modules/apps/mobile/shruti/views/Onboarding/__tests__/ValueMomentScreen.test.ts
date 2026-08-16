// @vitest-environment jsdom
/**
 * The last onboarding screen promises five lectures by name and seeds the
 * playlist Home renders from. Both must be the same five (#1888): the screen is
 * mounted from page 0, so the `seed` flip lands mid-flow while a reload is in
 * flight, and `trackIdsForTopics` picks a random five out of the topic pool —
 * a second resolve is a different five.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, createApp, defineComponent, h, nextTick, ref, type App } from "vue"

/* -- Module doubles ---------------------------------------------------- */

const state = vi.hoisted(() => ({
  /** Pool handed back per `topTrackIds` call, so a reload resolves a fresh
   *  set the way the real topic query does. */
  pools: [] as string[][],
  calls: 0,
  featured: [] as string[],
  added: [] as string[],
}))

const stub = (tag: string, name: string) =>
  defineComponent({
    name,
    setup:
      (_props, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })

vi.mock("@ui/components/tracks/list/index.js", () => ({
  // Renders one element per row carrying its track id — the rendered set the
  // seeded set has to match.
  TracksList: defineComponent({
    name: "TracksList",
    props: { rows: { type: Array, default: () => [] } },
    setup: (props) => () =>
      h(
        "tracks-list",
        (props.rows as { id: string }[]).map((row) => h("track-row", { "data-id": row.id }))
      ),
  }),
}))
vi.mock("@ui/components/tracks/state/index.js", () => ({
  TrackStateIndicator: stub("track-state", "TrackStateIndicator"),
}))
vi.mock("@shruti/composables/useTrackUiStateMapper.js", () => ({
  useTrackUiStateMapper: () => ({
    mapRows: (tracks: () => { id: string }[]) => computed(() => tracks()),
  }),
}))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    add: async (id: string) => {
      state.added.push(id)
    },
  }),
}))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      topics: {
        topTrackIds: async () => state.pools[Math.min(state.calls++, state.pools.length - 1)] ?? [],
      },
      collections: {
        listFeaturedCollections: async () => [{ id: "col_1" }],
        getCollectionTrackIds: async () => state.featured,
      },
      tracks: {
        getByIds: async (ids: readonly string[]) => new Map(ids.map((id) => [id, { id }])),
      },
    }),
  }),
}))

const { default: ValueMomentScreen } = await import("../screens/ValueMomentScreen.vue")

/* -- Harness ----------------------------------------------------------- */

let app: App | null = null
let host: HTMLElement | null = null
const seed = ref(false)

/** Mount the screen the way the carousel does — from page 0, with `seed` still
 *  false — and hand back the host plus the flip the topics page performs. */
async function render(topicIds: readonly string[]): Promise<HTMLElement> {
  seed.value = false
  const Host = defineComponent({
    setup: () => () => h(ValueMomentScreen, { topicIds, seed: seed.value }),
  })
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(Host)
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  await settle()
  return host
}

/** The load is a chain of awaits behind a watcher; let it run out. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function shown(el: HTMLElement): string[] {
  return [...el.querySelectorAll("track-row")].map((row) => row.getAttribute("data-id") ?? "")
}

beforeEach(() => {
  state.calls = 0
  state.pools = []
  state.featured = []
  state.added = []
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

/* -- Cases ------------------------------------------------------------- */

describe("ValueMomentScreen, after the topics page confirms the picks", () => {
  it("seeds the playlist with the lectures it is showing", async () => {
    // Two disjoint pools of twelve: whichever five the screen ends up on, they
    // came from one resolve, and seeding off the other one cannot match.
    state.pools = [
      Array.from({ length: 12 }, (_, i) => `a${i}`),
      Array.from({ length: 12 }, (_, i) => `b${i}`),
    ]

    const el = await render(["topic_a"])
    seed.value = true
    await settle()

    expect(shown(el)).toHaveLength(5)
    expect(state.added).toEqual(shown(el))
  })

  it("seeds the beginner collection when no topic was picked", async () => {
    state.featured = ["f0", "f1", "f2", "f3", "f4", "f5"]

    const el = await render([])
    seed.value = true
    await settle()

    expect(shown(el)).toEqual(["f0", "f1", "f2", "f3", "f4"])
    expect(state.added).toEqual(shown(el))
  })

  it("adds nothing until the picks are confirmed", async () => {
    state.pools = [Array.from({ length: 12 }, (_, i) => `a${i}`)]

    const el = await render(["topic_a"])

    expect(shown(el)).toHaveLength(5)
    expect(state.added).toEqual([])
  })
})
