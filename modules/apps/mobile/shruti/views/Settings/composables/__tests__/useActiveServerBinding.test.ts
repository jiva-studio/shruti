import { describe, expect, it } from "vitest"
import { ref } from "vue"
import type { CdnServer } from "@lib/domain/servers.js"
import { useActiveServerBinding } from "../useActiveServerBinding.js"

function region(id: string, fallbackOnly?: boolean): CdnServer {
  return {
    id,
    name: id.toUpperCase(),
    urlTemplate: `https://${id}.example/{path}`,
    shareAudioUrl: `https://${id}.example/share/audio/excerpts`,
    shareVideoUrl: `https://${id}.example/share/video/reels`,
    authBaseUrl: `https://${id}.example/auth`,
    chatBaseUrl: `https://${id}.example`,
    ...(fallbackOnly === undefined ? {} : { fallbackOnly }),
  }
}

describe("useActiveServerBinding", () => {
  it("offers every regular region and hides fallback-only ones", () => {
    const servers = [region("global"), region("russia", false), region("archive", true)]
    const { serverItems } = useActiveServerBinding({ servers, activeServer: ref(servers[0]!) })
    expect(serverItems).toEqual([
      { id: "global", title: "GLOBAL" },
      { id: "russia", title: "RUSSIA" },
    ])
  })
})
