import { beforeEach, describe, expect, it } from "vitest"
import {
  __resetStorageFailureForTests,
  recordStorageFailure,
  storageFailure,
} from "../storageHealth.js"

describe("storageHealth", () => {
  beforeEach(() => {
    __resetStorageFailureForTests()
  })

  it("reports no failure on a healthy start", () => {
    expect(storageFailure().value).toBeNull()
  })

  it("quotes the reason an open threw", () => {
    recordStorageFailure(new Error("database disk image is malformed"))

    expect(storageFailure().value).toBe("database disk image is malformed")
  })

  it("quotes a reason that was not an Error", () => {
    recordStorageFailure("SQLITE_CANTOPEN")

    expect(storageFailure().value).toBe("SQLITE_CANTOPEN")
  })

  it("keeps the latest reason", () => {
    const failure = storageFailure()
    recordStorageFailure(new Error("first"))

    recordStorageFailure(new Error("second"))

    expect(failure.value).toBe("second")
  })
})
