import { describe, expect, it } from "vitest"
import { deriveDiscoveryState, deriveUiState, type TrackListeningFacts } from "../trackUiState.js"

function facts(over: Partial<TrackListeningFacts> = {}): TrackListeningFacts {
  return {
    downloadState: "idle",
    isCurrentTrack: false,
    inPlaylist: false,
    entryCompleted: false,
    entryStarted: false,
    everCompleted: false,
    ...over,
  }
}

describe("deriveUiState", () => {
  it("lets an active download outrank every listening state", () => {
    expect(deriveUiState(facts({ downloadState: "pending", isCurrentTrack: true }))).toBe("pending")
    expect(deriveUiState(facts({ downloadState: "downloading", entryCompleted: true }))).toBe(
      "downloading"
    )
    expect(deriveUiState(facts({ downloadState: "failed", inPlaylist: true }))).toBe("failed")
  })

  it("prefers the completed item over the playing one", () => {
    expect(deriveUiState(facts({ entryCompleted: true, isCurrentTrack: true }))).toBe("completed")
  })

  it("prefers playing over saved progress", () => {
    expect(deriveUiState(facts({ isCurrentTrack: true, entryStarted: true }))).toBe("playing")
  })

  it("reports saved progress as queued", () => {
    expect(deriveUiState(facts({ inPlaylist: true, entryStarted: true }))).toBe("queued")
  })

  it("shows the lifetime badge only while the track is out of the playlist", () => {
    expect(deriveUiState(facts({ everCompleted: true }))).toBe("completed")
    expect(deriveUiState(facts({ everCompleted: true, inPlaylist: true }))).toBe("added")
  })

  it("falls back to none", () => {
    expect(deriveUiState(facts())).toBe("none")
  })
})

describe("deriveDiscoveryState", () => {
  it("keeps the download states", () => {
    expect(deriveDiscoveryState(facts({ downloadState: "downloading" }))).toBe("downloading")
  })

  it("folds playing and queued into added", () => {
    expect(deriveDiscoveryState(facts({ isCurrentTrack: true, inPlaylist: true }))).toBe("added")
    expect(deriveDiscoveryState(facts({ entryStarted: true, inPlaylist: true }))).toBe("added")
  })

  it("folds them into completed once the track was ever completed", () => {
    expect(deriveDiscoveryState(facts({ isCurrentTrack: true, everCompleted: true }))).toBe(
      "completed"
    )
    expect(deriveDiscoveryState(facts({ entryStarted: true, everCompleted: true }))).toBe(
      "completed"
    )
  })

  it("keeps the lifetime badge even while the track is in the playlist", () => {
    expect(deriveDiscoveryState(facts({ everCompleted: true, inPlaylist: true }))).toBe("completed")
  })

  it("falls back to added / none on plain membership", () => {
    expect(deriveDiscoveryState(facts({ inPlaylist: true }))).toBe("added")
    expect(deriveDiscoveryState(facts())).toBe("none")
  })
})
