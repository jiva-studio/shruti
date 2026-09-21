import { describe, expect, it } from "vitest"
import { WAVEFORM_RAW_PEAKS, buildPlaceholderPeaks, resamplePeaks } from "../useWaveform.js"

describe("buildPlaceholderPeaks", () => {
  it("gives the same note the same shape every time", () => {
    expect(buildPlaceholderPeaks("note-1", 32)).toEqual(buildPlaceholderPeaks("note-1", 32))
  })

  it("gives different notes different shapes", () => {
    expect(buildPlaceholderPeaks("note-1", 32)).not.toEqual(buildPlaceholderPeaks("note-2", 32))
  })

  it("fills exactly the requested bar count", () => {
    expect(buildPlaceholderPeaks("note-1", 24)).toHaveLength(24)
    expect(buildPlaceholderPeaks("note-1", 400)).toHaveLength(400)
    expect(buildPlaceholderPeaks("note-1", 0)).toEqual([])
  })

  it("keeps every bar inside the drawable 4..98 range", () => {
    for (const h of buildPlaceholderPeaks("whatever", 400)) {
      expect(h).toBeGreaterThanOrEqual(4)
      expect(h).toBeLessThanOrEqual(98)
    }
  })

  it("survives the seed hashing to zero", () => {
    expect(buildPlaceholderPeaks("", 8)).toHaveLength(8)
  })
})

describe("resamplePeaks", () => {
  it("keeps the loudest sample in each bucket", () => {
    expect(resamplePeaks([1, 9, 2, 3, 8, 4], 3)).toEqual([9, 3, 8])
  })

  it("returns a copy, not the original, when nothing is dropped", () => {
    const raw = [1, 2, 3]
    const out = resamplePeaks(raw, 5)
    expect(out).toEqual(raw)
    expect(out).not.toBe(raw)
  })

  it("is empty for a non-positive count or empty input", () => {
    expect(resamplePeaks([1, 2, 3], 0)).toEqual([])
    expect(resamplePeaks([1, 2, 3], -1)).toEqual([])
    expect(resamplePeaks([], 10)).toEqual([])
  })

  it("down-samples the full decode resolution to any bar count", () => {
    const raw = Array.from({ length: WAVEFORM_RAW_PEAKS }, (_, i) => i)
    expect(resamplePeaks(raw, 24)).toHaveLength(24)
    expect(resamplePeaks(raw, 100)).toHaveLength(100)
  })
})
