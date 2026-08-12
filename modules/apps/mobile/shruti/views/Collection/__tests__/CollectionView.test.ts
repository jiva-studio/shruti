// @vitest-environment jsdom
/**
 * Qase case 334. Not a Playwright journey: every collection in the offline e2e
 * fixture exists in both languages, so the null bail path is unreachable there.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { computed, createApp, defineComponent, h, nextTick, ref, type App } from "vue"

/* -- Module doubles ---------------------------------------------------- */

const state = vi.hoisted(() => ({
  getCollection: (async () => null) as (id: string, locale: string) => Promise<unknown>,
}))

vi.mock("vue-i18n", () => ({
  // Identity `t` — the assertions read i18n KEYS, which is what the bail path
  // actually decides between.
  useI18n: () => ({ t: (key: string) => key }),
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
  alertController: { create: vi.fn() },
  IonBackButton: stub("ion-back-button", "IonBackButton"),
  IonButton: stub("ion-button", "IonButton"),
  IonButtons: stub("ion-buttons", "IonButtons"),
  IonContent: stub("ion-content", "IonContent"),
  IonHeader: stub("ion-header", "IonHeader"),
  IonPage: stub("ion-page", "IonPage"),
  IonSpinner: stub("ion-spinner", "IonSpinner"),
  IonTitle: stub("ion-title", "IonTitle"),
  IonToolbar: stub("ion-toolbar", "IonToolbar"),
}))
vi.mock("@tabler/icons-vue", () => ({ IconPlaylistAdd: stub("icon-add", "IconPlaylistAdd") }))
vi.mock("@ui/primitives/index.js", () => ({
  CachedImage: stub("cached-image", "CachedImage"),
  // Renders its two texts so a case can assert WHICH message the page chose.
  PageSticker: defineComponent({
    name: "PageSticker",
    props: { header: String, message: String },
    setup: (props) => () => h("page-sticker", `${props.header ?? ""}|${props.message ?? ""}`),
  }),
}))
vi.mock("@ui/components/tracks/list/index.js", () => ({
  TracksList: stub("tracks-list", "TracksList"),
}))
vi.mock("@ui/components/tracks/state/index.js", () => ({
  TrackStateIndicator: stub("track-state", "TrackStateIndicator"),
}))
vi.mock("@shruti/services/regionsRegistry.js", () => ({ resolveAssetUrl: (k: string) => k }))
vi.mock("@shruti/shruti.js", () => ({
  useShruti: () => ({
    repositories: () => ({
      collections: { getCollection: state.getCollection },
      tracks: { getByIds: async () => new Map() },
      topics: { topTrackIds: async () => [] },
    }),
  }),
}))
vi.mock("@shruti/stores/usePlaylistStore.js", () => ({
  usePlaylistStore: () => ({ add: vi.fn() }),
}))
vi.mock("@shruti/stores/useDictionariesStore.js", () => ({
  useDictionariesStore: () => ({
    ensureLoaded: async () => {},
    topicNamesById: new Map(),
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
  useTrackActionSheet: () => ({ present: vi.fn() }),
}))
vi.mock("@lib/domain/services/localizedName.js", () => ({ preferredLibraryLanguage: () => "en" }))
vi.mock("@usecases", () => ({ addTracksToPlaylist: vi.fn() }))
vi.mock("@kit/composables", () => ({ useToast: () => ({ error: vi.fn() }) }))

const { default: CollectionView } = await import("../CollectionView.vue")

/* -- Harness ----------------------------------------------------------- */

let app: App | null = null
let host: HTMLElement | null = null

async function render(): Promise<HTMLElement> {
  host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(CollectionView, { id: "pack_1", kind: "collection" })
  app.mount(host)
  // The load is a chain of awaits behind a `watch(..., { immediate: true })`.
  for (let i = 0; i < 10; i++) await nextTick()
  return host
}

function sticker(el: HTMLElement): string | null {
  return el.querySelector("page-sticker")?.textContent ?? null
}

beforeEach(() => {
  state.getCollection = async () => null
})

afterEach(() => {
  app?.unmount()
  host?.remove()
  app = null
  host = null
})

/* -- Cases ------------------------------------------------------------- */

describe("CollectionView, when the collection does not load", () => {
  it("names the language gap instead of rendering as an empty collection", async () => {
    // 244 of 265 collection ids exist in one language only: switching the
    // content language with the page open returns null here.
    const el = await render()
    expect(sticker(el)).toBe("search.collections.missingTitle|search.collections.missingMessage")
    expect(el.querySelector("tracks-list")).toBeNull()
    // No cover and no title to put in it — the hero would be a grey block.
    expect(el.querySelector(".hero")).toBeNull()
  })

  it("says the load failed when the repository throws", async () => {
    state.getCollection = async () => {
      throw new Error("db closed")
    }
    const el = await render()
    expect(sticker(el)).toBe("|search.collections.loadFailed")
    expect(el.querySelector("tracks-list")).toBeNull()
  })
})

describe("CollectionView, when the collection loads", () => {
  it("shows the list, with no error message, even when it holds nothing", async () => {
    state.getCollection = async () => ({
      name: "Bhagavad-gita",
      description: "",
      cover: null,
      trackIds: [],
    })
    const el = await render()
    expect(sticker(el)).toBeNull()
    expect(el.querySelector("tracks-list")).not.toBeNull()
    expect(el.querySelector(".hero-title")?.textContent).toBe("Bhagavad-gita")
  })
})
