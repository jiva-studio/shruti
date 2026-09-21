import { describe, expect, it } from "vitest"
import {
  PUCK_HALF,
  findNearestPreset,
  formatRate,
  fractionFromClientX,
  leftCalc,
  presetLeftFraction,
} from "../speedSliderGeometry.js"

const PRESETS = [0.75, 1.0, 1.25, 1.5, 1.75, 2.0]

describe("presetLeftFraction", () => {
  it("pins the bounds to the ends of the rail", () => {
    expect(presetLeftFraction(0.75, 0.75, 2)).toBe(0)
    expect(presetLeftFraction(2, 0.75, 2)).toBe(1)
  })

  it("places a rate linearly between them", () => {
    expect(presetLeftFraction(1.375, 0.75, 2)).toBeCloseTo(0.5)
  })
})

describe("leftCalc", () => {
  it("insets the rail by half a puck at both ends", () => {
    expect(leftCalc(0)).toBe(`calc(${PUCK_HALF}px + (100% - ${PUCK_HALF * 2}px) * 0)`)
  })
})

describe("fractionFromClientX", () => {
  it("maps the inner rail, not the raw track width", () => {
    expect(fractionFromClientX(10, 0, 220)).toBe(0)
    expect(fractionFromClientX(210, 0, 220)).toBe(1)
    expect(fractionFromClientX(110, 0, 220)).toBeCloseTo(0.5)
  })

  it("clamps a drag that runs off either end", () => {
    expect(fractionFromClientX(-500, 0, 220)).toBe(0)
    expect(fractionFromClientX(5000, 0, 220)).toBe(1)
  })
})

describe("findNearestPreset", () => {
  it("snaps to the closest preset", () => {
    expect(findNearestPreset(1.3, PRESETS)).toBe(1.25)
    expect(findNearestPreset(0.1, PRESETS)).toBe(0.75)
    expect(findNearestPreset(9, PRESETS)).toBe(2)
  })

  it("keeps the lower preset when the value sits exactly between two", () => {
    expect(findNearestPreset(1.125, PRESETS)).toBe(1)
  })
})

describe("formatRate", () => {
  it("drops the decimals a whole rate does not need", () => {
    expect(formatRate(1)).toBe("1")
    expect(formatRate(2.0)).toBe("2")
  })

  it("keeps a fractional rate as it reads", () => {
    expect(formatRate(0.75)).toBe("0.75")
    expect(formatRate(1.25)).toBe("1.25")
  })
})
