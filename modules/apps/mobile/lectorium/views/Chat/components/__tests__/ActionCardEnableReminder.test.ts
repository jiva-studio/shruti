// @vitest-environment jsdom
/**
 * The reminder card is the one action whose payload the user may edit before
 * confirming, so what reaches the store is the time shown in the picker — not
 * the time the assistant proposed.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { createApp, defineComponent, h, nextTick, ref, type App } from "vue"
import type { ChatActionPayload } from "@lib/domain/chatMessage.js"
import type { ActionState } from "@lectorium/stores/useChatStore.js"

vi.mock("@ionic/vue", () => ({
  IonSpinner: defineComponent({ name: "IonSpinner", setup: () => () => h("ion-spinner") }),
}))

const { default: ActionCardEnableReminder } = await import("../ActionCardEnableReminder.vue")

type ReminderPayload = Extract<ChatActionPayload, { kind: "enable_daily_reminder" }>

function payload(over: Partial<ReminderPayload> = {}): ReminderPayload {
  return { kind: "enable_daily_reminder", id: "act-1", time: "19:30", ...over }
}

let app: App | null = null

interface Rendered {
  readonly host: HTMLElement
  readonly confirms: { actionId: string; override?: { time?: string } }[]
  readonly payload: ReturnType<typeof ref<ReminderPayload | undefined>>
}

function render(initial: ReminderPayload | undefined, state: ActionState = "pending"): Rendered {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const confirms: { actionId: string; override?: { time?: string } }[] = []
  const payloadRef = ref<ReminderPayload | undefined>(initial)
  app = createApp(
    defineComponent({
      setup: () => () =>
        h(ActionCardEnableReminder, {
          actionId: "act-1",
          payload: payloadRef.value,
          state,
          onConfirm: (actionId: string, override?: { time?: string }) =>
            confirms.push({ actionId, override }),
        }),
    })
  )
  app.config.globalProperties.$t = (key: string) => key
  app.mount(host)
  return { host, confirms, payload: payloadRef }
}

const timeInput = (host: HTMLElement): HTMLInputElement =>
  host.querySelector("input[type='time']") as HTMLInputElement

const confirmButton = (host: HTMLElement): HTMLButtonElement | null => host.querySelector(".btn")

afterEach(() => {
  app?.unmount()
  app = null
  document.body.innerHTML = ""
})

describe("ActionCardEnableReminder", () => {
  it("shows the degraded placeholder when the payload never arrived", () => {
    const { host } = render(undefined)

    expect(host.querySelector(".broken")).not.toBeNull()
    expect(host.querySelector("input[type='time']")).toBeNull()
  })

  it("offers the time the assistant proposed", () => {
    const { host } = render(payload())

    expect(timeInput(host).value).toBe("19:30")
  })

  // `time` is a plain string on the wire, so a server with nothing to propose
  // sends "". Offering that blank would confirm a blank time.
  it("falls back to the morning default when the proposed time is blank", async () => {
    const rendered = render(payload({ time: "" }))

    expect(timeInput(rendered.host).value).toBe("07:00")
    confirmButton(rendered.host)!.click()
    await nextTick()
    expect(rendered.confirms).toEqual([{ actionId: "act-1", override: { time: "07:00" } }])
  })

  it("confirms with the proposed time untouched", async () => {
    const rendered = render(payload())
    confirmButton(rendered.host)!.click()
    await nextTick()

    expect(rendered.confirms).toEqual([{ actionId: "act-1", override: { time: "19:30" } }])
  })

  it("confirms with the time the user picked instead", async () => {
    const rendered = render(payload())
    const input = timeInput(rendered.host)
    input.value = "06:15"
    input.dispatchEvent(new Event("input"))
    await nextTick()

    confirmButton(rendered.host)!.click()
    await nextTick()

    expect(rendered.confirms).toEqual([{ actionId: "act-1", override: { time: "06:15" } }])
  })

  it("follows a payload the assistant re-issued with another time", async () => {
    const rendered = render(payload())
    rendered.payload.value = payload({ time: "05:45" })
    await nextTick()

    expect(timeInput(rendered.host).value).toBe("05:45")
  })

  it("keeps the user's own choice when the payload is re-issued unchanged", async () => {
    const rendered = render(payload())
    const input = timeInput(rendered.host)
    input.value = "06:15"
    input.dispatchEvent(new Event("input"))
    await nextTick()

    rendered.payload.value = payload()
    await nextTick()

    expect(timeInput(rendered.host).value).toBe("06:15")
  })

  it("locks the picker while the reminder is being set", () => {
    const { host } = render(payload(), "executing")

    expect(timeInput(host).disabled).toBe(true)
    expect(confirmButton(host)!.disabled).toBe(true)
  })

  it("locks it once the reminder is set, and says so", () => {
    const { host } = render(payload(), "done")

    expect(timeInput(host).disabled).toBe(true)
    expect(host.querySelector(".hint")?.textContent).toBe("chat.actionEnableReminderDone")
    expect(confirmButton(host)).toBeNull()
  })

  it("lets the user change the time and try again after a failure", async () => {
    const rendered = render(payload(), "error")
    expect(timeInput(rendered.host).disabled).toBe(false)
    expect(rendered.host.querySelector(".hint.error")?.textContent).toBe(
      "chat.actionEnableReminderError"
    )

    confirmButton(rendered.host)!.click()
    await nextTick()
    expect(rendered.confirms).toEqual([{ actionId: "act-1", override: { time: "19:30" } }])
  })
})
