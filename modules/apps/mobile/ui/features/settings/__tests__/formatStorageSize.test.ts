import { describe, expect, it } from "vitest"
import { formatStorageSize } from "../formatStorageSize.js"

const GIB = 1024 * 1024 * 1024
const MIB = 1024 * 1024

describe("formatStorageSize", () => {
  it("renders whole-gigabyte presets without a decimal tail", () => {
    expect(formatStorageSize(8 * GIB, "en")).toBe("8 GB")
  })

  it("keeps one decimal for a partial figure below 10 GB", () => {
    expect(formatStorageSize(1.4 * GIB, "en")).toBe("1.4 GB")
  })

  it("drops the decimal past 10 GB, where it is noise", () => {
    expect(formatStorageSize(12.4 * GIB, "en")).toBe("12 GB")
  })

  it("stays in megabytes below 1 GB so a small cache doesn't read as zero", () => {
    expect(formatStorageSize(340 * MIB, "en")).toBe("340 MB")
  })

  it("localises the unit", () => {
    expect(formatStorageSize(8 * GIB, "ru")).toContain("8")
    expect(formatStorageSize(8 * GIB, "ru")).not.toContain("GB")
  })

  it("renders an empty cache as 0 MB rather than blank", () => {
    expect(formatStorageSize(0, "en")).toBe("0 MB")
  })
})
