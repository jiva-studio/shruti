import { describe, expect, it, vi } from "vitest"
import { ref } from "vue"

const currentRoute = ref<{ name: string }>({ name: "search" })
vi.mock("@shruti/router/index.js", () => ({ default: { currentRoute } }))

const { useSearchDock } = await import("../useSearchDock.js")

describe("useSearchDock", () => {
  it("hands the field to whichever dock page is on top (#1786)", () => {
    const dock = useSearchDock()
    const onSearch = dock.owns("search")
    const onWeb = dock.owns("web-results")

    expect(dock.visible.value).toBe(true)
    expect(onSearch.value).toBe(true)
    expect(onWeb.value).toBe(false)

    // "See all" pushes the web page on top; the tab underneath stays mounted
    // and keeps reading the same field, but it no longer owns it.
    currentRoute.value = { name: "web-results" }
    expect(dock.visible.value).toBe(true)
    expect(onSearch.value).toBe(false)
    expect(onWeb.value).toBe(true)

    currentRoute.value = { name: "search" }
    expect(onSearch.value).toBe(true)
  })

  it("belongs to no page where the field does not show", () => {
    const dock = useSearchDock()
    currentRoute.value = { name: "home" }

    expect(dock.visible.value).toBe(false)
    expect(dock.owns("search").value).toBe(false)
  })
})
