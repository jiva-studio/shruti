// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue"
import type { Track } from "@lib/domain/track.js"
import type { ChartDay } from "../../weeklyDigest.js"

/* -- Module doubles ----------------------------------------------------- */

const repos = {
  listeningSessions: {
    getDailyTotalsByDayOffset: vi.fn(),
    getTracksListenedInRange: vi.fn(),
  },
  playlistItems: {},
  tracks: { getByIds: vi.fn() },
}

const overview = vi.fn()

const badge = (name: string, cls: string) =>
  defineComponent({
    name,
    props: { text: String, title: String, value: [Number, String], label: String },
    setup: (p) => () => h("span", { class: cls }, `${p.label ?? p.title}:${p.value ?? p.text}`),
  })

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (k: string, args?: Record<string, unknown>) =>
      args ? `${k}(${Object.values(args).join(",")})` : k,
  }),
}))
vi.mock("@lectorium/lectorium.js", () => ({ useLectorium: () => ({ repositories: () => repos }) }))
vi.mock("@lectorium/composables/useAppLanguage.js", () => ({ useAppLanguage: () => ref("en") }))
vi.mock("@lectorium/composables/useLibraryLanguages.js", () => ({
  useLibraryLanguages: () => ref(["en"]),
}))
vi.mock("@lectorium/composables/useDurationFormatter.js", () => ({
  useDurationFormatter: () => (seconds: number) => `${seconds}s`,
}))
vi.mock("@usecases/activity/getActivityOverview.js", () => ({
  getActivityOverview: (...args: unknown[]) => overview(...args),
}))
vi.mock("@ui/components/badges/index.js", () => ({ DurationBadge: badge("DurationBadge", "dur") }))
vi.mock("@ui/features/activity/index.js", () => ({
  ActivityStatBadge: badge("ActivityStatBadge", "stat"),
}))
vi.mock("@ui/icons/index.js", () => ({
  FlameIcon: defineComponent({ name: "FlameIcon", setup: () => () => h("i") }),
  IconRosetteDiscountCheckFilled: defineComponent({
    name: "IconRosetteDiscountCheckFilled",
    setup: () => () => h("i"),
  }),
}))
vi.mock("../WeeklyDigestChart.vue", () => ({
  default: defineComponent({
    name: "WeeklyDigestChart",
    props: { days: { type: Array, default: () => [] }, label: String },
    setup: (p) => () =>
      h(
        "div",
        { class: "chart" },
        (p.days as ChartDay[]).map((d) => h("span", { class: "bar" }, String(d.listenedSeconds)))
      ),
  }),
}))

const { default: WeeklyDigestCard } = await import("../WeeklyDigestCard.vue")

/* -- Fixtures ----------------------------------------------------------- */

const FROM_MS = Date.UTC(2026, 0, 5)
const TO_MS = Date.UTC(2026, 0, 12)

function track(id: string, title: string): Track {
  return {
    id,
    variants: [{ language: "en", title, audio: null }],
  } as unknown as Track
}

function listened(n: number): { trackId: string; listenedSeconds: number }[] {
  return Array.from({ length: n }, (_, i) => ({
    trackId: `t${i + 1}`,
    listenedSeconds: (i + 1) * 60,
  }))
}

/* -- Harness ------------------------------------------------------------ */

let app: App | null = null

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {})
  repos.listeningSessions.getDailyTotalsByDayOffset.mockResolvedValue([])
  repos.listeningSessions.getTracksListenedInRange.mockResolvedValue([])
  repos.tracks.getByIds.mockResolvedValue(new Map())
  overview.mockResolvedValue({ currentStreak: 0, completedCount: 0 })
})

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

async function render(): Promise<HTMLElement> {
  const host = document.createElement("div")
  document.body.appendChild(host)
  app = createApp(WeeklyDigestCard, { fromMs: FROM_MS, toMs: TO_MS })
  app.mount(host)
  for (let i = 0; i < 10; i++) await Promise.resolve()
  await nextTick()
  return host
}

const rowTitles = (host: HTMLElement): string[] =>
  Array.from(host.querySelectorAll(".digest-row-title")).map((e) => e.textContent ?? "")

const badgeTexts = (host: HTMLElement, cls: string): string[] =>
  Array.from(host.querySelectorAll(cls)).map((e) => e.textContent ?? "")

describe("the summary row", () => {
  it("shows the week's total time alongside the counts", async () => {
    repos.listeningSessions.getDailyTotalsByDayOffset.mockResolvedValue([
      { dayOffset: 0, listenedSeconds: 600 },
      { dayOffset: 3, listenedSeconds: 900 },
    ])
    overview.mockResolvedValue({ currentStreak: 4, completedCount: 2 })

    const host = await render()

    expect(badgeTexts(host, ".dur")).toEqual(["chat.weeklyDigestTotalTime:1500s"])
    expect(badgeTexts(host, ".stat")).toEqual(["activity.completedLectures:2", "activity.streak:4"])
  })

  it("leaves the time badge off a week with no listening", async () => {
    const host = await render()
    expect(host.querySelector(".dur")).toBeNull()
    expect(badgeTexts(host, ".stat")).toEqual(["activity.completedLectures:0", "activity.streak:0"])
  })

  it("draws seven bars, filling the days with no listening", async () => {
    repos.listeningSessions.getDailyTotalsByDayOffset.mockResolvedValue([
      { dayOffset: 2, listenedSeconds: 300 },
    ])
    const host = await render()
    expect(Array.from(host.querySelectorAll(".bar")).map((b) => b.textContent)).toEqual([
      "0",
      "0",
      "300",
      "0",
      "0",
      "0",
      "0",
    ])
  })
})

describe("the lecture list", () => {
  it("names each lecture and how long it was listened to", async () => {
    repos.listeningSessions.getTracksListenedInRange.mockResolvedValue([
      { trackId: "t1", listenedSeconds: 120 },
      { trackId: "t2", listenedSeconds: 240 },
    ])
    repos.tracks.getByIds.mockResolvedValue(
      new Map([
        ["t1", track("t1", "Evening lecture")],
        ["t2", track("t2", "Morning class")],
      ])
    )

    const host = await render()

    expect(rowTitles(host)).toEqual(["Evening lecture", "Morning class"])
    expect(
      Array.from(host.querySelectorAll(".digest-row-duration")).map((e) => e.textContent)
    ).toEqual(["120s", "240s"])
    expect(host.querySelector(".digest-empty")).toBeNull()
  })

  it("keeps a row whose track is no longer in the catalog", async () => {
    repos.listeningSessions.getTracksListenedInRange.mockResolvedValue([
      { trackId: "gone", listenedSeconds: 60 },
    ])
    const host = await render()
    expect(rowTitles(host)).toEqual([""])
    expect(host.querySelector(".digest-row-duration")?.textContent).toBe("60s")
  })

  it("shows eight lectures and folds the rest into a count", async () => {
    repos.listeningSessions.getTracksListenedInRange.mockResolvedValue(listened(11))
    repos.tracks.getByIds.mockResolvedValue(
      new Map(listened(11).map((r) => [r.trackId, track(r.trackId, `Lecture ${r.trackId}`)]))
    )

    const host = await render()

    expect(rowTitles(host)).toHaveLength(8)
    expect(host.querySelector(".digest-more")?.textContent?.trim()).toBe("chat.weeklyDigestMore(3)")
  })

  it("shows no fold-out line at exactly eight lectures", async () => {
    repos.listeningSessions.getTracksListenedInRange.mockResolvedValue(listened(8))
    const host = await render()
    expect(rowTitles(host)).toHaveLength(8)
    expect(host.querySelector(".digest-more")).toBeNull()
  })

  it("says the week was empty once the read comes back with nothing", async () => {
    const host = await render()
    expect(host.querySelector(".digest-list")).toBeNull()
    expect(host.querySelector(".digest-empty")?.textContent).toBe("chat.weeklyDigestEmpty")
  })
})

describe("when the read fails", () => {
  it("settles on the empty state instead of hanging on a blank card", async () => {
    repos.listeningSessions.getDailyTotalsByDayOffset.mockRejectedValue(new Error("db closed"))
    const host = await render()
    expect(host.querySelector(".digest-empty")?.textContent).toBe("chat.weeklyDigestEmpty")
    expect(host.querySelector(".dur")).toBeNull()
  })

  it("shows nothing at all before the first read resolves", async () => {
    repos.listeningSessions.getDailyTotalsByDayOffset.mockReturnValue(new Promise(() => {}))
    const host = await render()
    expect(host.querySelector(".digest-empty")).toBeNull()
    expect(host.querySelector(".digest-list")).toBeNull()
    expect(host.querySelector(".digest-title")?.textContent).toBe("chat.weeklyDigestTitle")
  })
})
