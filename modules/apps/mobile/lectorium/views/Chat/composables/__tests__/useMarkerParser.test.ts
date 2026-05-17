import { describe, expect, it } from "vitest"
import { parseChatMarkers } from "../useMarkerParser.js"

/**
 * Marker grammar coverage. The parser is the bridge between LLM-emitted
 * inline markers and the bubble's component renderer — a regex regression
 * here silently turns markers into text tokens.
 */
describe("parseChatMarkers — action markers", () => {
  it("recognises create-playlist with hex id", () => {
    const tokens = parseChatMarkers("ok [action:create-playlist|id=abc12345]")
    const action = tokens.find((t) => t.kind === "action")
    expect(action).toBeTruthy()
    if (action && action.kind === "action") {
      expect(action.actionKind).toBe("create_playlist")
      expect(action.actionId).toBe("abc12345")
    }
  })

  it("recognises save-note with underscore id", () => {
    const tokens = parseChatMarkers("[action:save-note|id=note_ABC_1]")
    const action = tokens.find((t) => t.kind === "action")
    expect(action).toBeTruthy()
    if (action && action.kind === "action") {
      expect(action.actionKind).toBe("save_note")
      expect(action.actionId).toBe("note_ABC_1")
    }
  })

  it("rejects malformed markers — wrong delimiter, spaces inside id", () => {
    const tokens1 = parseChatMarkers("[action:create-playlist id=abc12345]")
    const tokens2 = parseChatMarkers("[action:create-playlist|id=abc 12345]")
    expect(tokens1.find((t) => t.kind === "action")).toBeUndefined()
    expect(tokens2.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("does not match when kind starts with a digit", () => {
    const tokens = parseChatMarkers("[action:42-bad|id=abc12345]")
    expect(tokens.find((t) => t.kind === "action")).toBeUndefined()
  })

  it("finds multiple action markers in one message", () => {
    const tokens = parseChatMarkers(
      "first [action:create-playlist|id=aaa] then [action:save-note|id=bbb]"
    )
    const actions = tokens.filter((t) => t.kind === "action")
    expect(actions).toHaveLength(2)
  })
})
