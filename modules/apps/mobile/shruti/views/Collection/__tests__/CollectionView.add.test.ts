// @vitest-environment jsdom
/**
 * The "add the whole collection to my playlist" flow and the page chrome
 * around it: the confirmation, what actually reaches the playlist, and what
 * the user is told when the write fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, createApp, defineComponent, h, nextTick, onMounted, ref, type App } from "vue"

/* -- Module doubles ---------------------------------------------------- */

interface AlertButton {
  readonly text: string
  readonly role?: string
  readonly handler?: () => void
}

interface AlertOptions {
  readonly header?: string
  readonly message?: string
  readonly buttons: readonly AlertButton[]
}

const state = vi.hoisted(() => ({
  trackIds: [] as string[],
  addFails: false,
  alerts: [] as { header?: string; message?: string; buttons: readonly AlertButton[] }[],
  added: [] as [string, string | null][],
  toasts: [] as string[],
  sheets: [] as string[],
  /** Set to hold every `playlist.add` until the case lets it through. */
  addGate: null as { promise: Promise<void>; open: () => void } | null,
}))

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params && "count" in params ? `${key}:${String(params.count)}` : key,
  }),
}))

const stub = (tag: string, name: string) =>
  defineComponent({
    name,
    setup:
      (_props, { slots }) =>
      () =>
        h(tag, slots.default?.()),
  })

vi.mock("@ionic/vue", () => ({
  alertController: {
    create: async (options: AlertOptions) => {
      state.alerts.push(options)
      return { present: async () => {} }
    },
  },
  IonBackButton: stub("ion-back-button", "IonBackButton"),
  IonButton: defineComponent({
    name: "IonButton",
    setup:
      (_props, { slots }) =>
      () =>
        h("button", slots.default?.()),
  }),
  IonButtons: stub("ion-buttons", "IonButtons"),
  // Ionic re-publishes the element's scroll as its own `ionScroll` event; the
  // stub does the same so the view is driven through its real contract.
  IonContent: defineComponent({
    name: "IonContent",
    emits: ["ionScroll"],
    setup(_props, { slots, emit }) {
      const el = ref<HTMLElement | null>(null)
      onMounted(() => el.value?.addEventListener("scroll", (e) => emit("ionScroll", e)))
      return () => h("ion-content", { ref: el }, slots.default?.())
    },
  }),
  IonHeader: stub("ion-header", "IonHeader"),
  IonPage: stub("ion-page", "IonPage"),
  IonSpinner: stub("ion-spinner", "IonSpinner"),
  IonTitle: stub("ion-title", "IonTitle"),
  IonToolbar: stub("ion-toolbar", "IonToolbar"),
}))
vi.mock("@tabler/icons-vue", () => ({ IconPlaylistAdd: stub("icon-add", "IconPlaylistAdd") }))
vi.mock("@ui/primitives/index.js", () => ({
  CachedImage: stub("cached-image", "CachedImage"),
  PageSticker: defineComponent({
    name: "PageSticker",
    props: { header: String, message: String },
    setup: (props) => () => h("page-sticker", `${props.header ?? ""}|${props.message ?? ""}`),
  }),
}))
vi.mock("@shruti/views/components/TrackRowsList.vue", () => ({
  default: defineComponent({
    name: "TrackRowsList",
    props: { rows: { type: Array, required: true } },
    emits: ["select"],
    setup:
      (props, { emit }) =>
      () =>
        h(
          "track-rows",
          (props.rows as { id: string }[]).map((row) =>
            h("button", { class: "row", onClick: () => emit("select", row.id) }, row.id)
          )
        ),
  }),
}))
vi.mock("@shruti/services/regionsRegistry.js", () => ({ resolveAssetUrl: (k: string) => k }))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      collections: {
        getCollection: async () => ({
          name: "Bhagavad-gita",
          description: "Talks on the second chapter",
          cover: "covers/bg.jpg",
          trackIds: state.trackIds,
        }),
      },
      tracks: {
        getByIds: async (ids: readonly string[]) =>
          new Map(ids.map((id) => [id, { id, variants: [{ language: "en" }] }])),
      },
      topics: { topTrackIds: async () => state.trackIds },
    }),
  }),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({
    add: async (id: string, collectionId: string | null) => {
      if (state.addGate) await state.addGate.promise
      if (state.addFails) throw new Error("db closed")
      state.added.push([id, collectionId])
    },
  }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: async () => {},
    topicNamesById: new Map([["topic-1", "Renunciation"]]),
    topicCoverById: new Map(),
  }),
}))
vi.mock("@shruti/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@shruti/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@shruti/composables/useTrackUiStateMapper.js", () => ({
  useTrackUiStateMapper: () => ({ mapRows: (tracks: () => unknown[]) => computed(() => tracks()) }),
}))
vi.mock("@shruti/composables/useTrackActionSheet.js", () => ({
  useTrackActionSheet: () => ({ present: async (id: string) => void state.sheets.push(id) }),
}))
vi.mock("@lib/domain/services/localizedName.js", () => ({ preferredLibraryLanguage: () => "en" }))
vi.mock("@usecases", async () => ({
  addTracksToPlaylist: (await import("@usecases/chat/addTracksToPlaylist.js")).addTracksToPlaylist,
}))
vi.mock("@kit/composables", () => ({
  useToast: () => ({ error: async (message: string) => void state.toasts.push(message) }),
}))

const { default: CollectionView } = await import("../CollectionView.vue")

/* -- Harness ----------------------------------------------------------- */

let app: App | null = null

async function render(kind?: "collection" | "topic"): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(CollectionView, { id: kind === "topic" ? "topic-1" : "pack_1", kind })
  app.mount(host)
  await settle()
  return host
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await nextTick()
}

const addButton = (host: HTMLElement): HTMLButtonElement =>
  host.querySelector("button[aria-label='search.collections.addAll']") as HTMLButtonElement

async function confirmLastAlert(): Promise<void> {
  const buttons = state.alerts[state.alerts.length - 1].buttons
  buttons.find((b) => b.role === "confirm")?.handler?.()
  await settle()
}

beforeEach(() => {
  state.trackIds = ["t-1", "t-2"]
  state.addFails = false
  state.alerts = []
  state.added = []
  state.toasts = []
  state.sheets = []
  state.addGate = null
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

/* -- Cases ------------------------------------------------------------- */

describe("CollectionView, adding the whole collection", () => {
  it("asks for confirmation, naming how many lectures are at stake", async () => {
    const host = await render()
    addButton(host).click()
    await settle()

    expect(state.alerts).toHaveLength(1)
    expect(state.alerts[0].header).toBe("search.collections.addAll")
    expect(state.alerts[0].message).toBe("search.collections.addConfirm:2")
    expect(state.added).toEqual([])
  })

  it("offers a way out that adds nothing", async () => {
    const host = await render()
    addButton(host).click()
    await settle()

    const cancel = state.alerts[0].buttons.find((b) => b.role === "cancel")
    expect(cancel?.text).toBe("app.cancel")
    expect(cancel?.handler).toBeUndefined()
    expect(state.added).toEqual([])
  })

  it("adds every track, attributed to the collection it came from", async () => {
    const host = await render()
    addButton(host).click()
    await settle()
    await confirmLastAlert()

    expect(state.added).toEqual([
      ["t-1", "pack_1"],
      ["t-2", "pack_1"],
    ])
    expect(state.toasts).toEqual([])
  })

  it("treats a page opened without a kind as a collection", async () => {
    const host = await render()
    addButton(host).click()
    await settle()
    await confirmLastAlert()

    expect(state.added).toEqual([
      ["t-1", "pack_1"],
      ["t-2", "pack_1"],
    ])
  })

  it("leaves a topic shelf's tracks standalone", async () => {
    const host = await render("topic")
    addButton(host).click()
    await settle()
    await confirmLastAlert()

    expect(state.added).toEqual([
      ["t-1", null],
      ["t-2", null],
    ])
  })

  it("tells the user when the playlist write fails", async () => {
    const host = await render()
    state.addFails = true
    addButton(host).click()
    await settle()
    await confirmLastAlert()

    expect(state.toasts).toEqual(["search.collections.addError"])
  })

  it("offers nothing to add on a collection that failed to load", async () => {
    state.trackIds = []
    const host = await render()

    expect(addButton(host).disabled).toBe(true)
    addButton(host).click()
    await settle()
    expect(state.alerts).toEqual([])
  })

  it("holds the button while the add is in flight, so it cannot be fired twice", async () => {
    const host = await render()
    let open!: () => void
    const promise = new Promise<void>((resolve) => (open = resolve))
    state.addGate = { promise, open }

    addButton(host).click()
    await settle()
    await confirmLastAlert()
    expect(addButton(host).disabled).toBe(true)

    state.addGate = null
    open()
    await settle()

    expect(addButton(host).disabled).toBe(false)
    expect(state.added).toHaveLength(2)
  })
})

describe("CollectionView chrome", () => {
  it("shows the collection's description above the list", async () => {
    const host = await render()
    expect(host.querySelector(".description")?.textContent).toBe("Talks on the second chapter")
  })

  it("fades the toolbar title in as the hero scrolls away", async () => {
    const host = await render()
    const title = host.querySelector("ion-title") as HTMLElement
    expect(title.style.opacity).toBe("0")

    host
      .querySelector("ion-content")!
      .dispatchEvent(new CustomEvent("scroll", { detail: { scrollTop: 240 } }))
    await settle()

    expect(title.style.opacity).toBe("1")
  })

  it("opens the track's action sheet when a row is tapped", async () => {
    const host = await render()
    host.querySelector<HTMLElement>(".row")!.click()
    await settle()

    expect(state.sheets).toEqual(["t-1"])
  })
})
