// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, reactive } from "vue"
import ChatSendButton from "../ChatSendButton.vue"

interface Props {
  sending: boolean
  hasText: boolean
  disabled?: boolean
  label: string
}

interface Mounted {
  props: Props
  button: HTMLButtonElement
  sends: number
  cancels: number
}

function mount(props: Props): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const state = reactive(props)
  const m = { props: state, sends: 0, cancels: 0 } as Mounted
  createApp({
    render: () =>
      h(
        ChatSendButton,
        { ...state, onSend: () => (m.sends += 1), onCancel: () => (m.cancels += 1) },
        { spinner: () => h("i", { class: "dots" }) }
      ),
  }).mount(host)
  m.button = host.querySelector<HTMLButtonElement>("button.action")!
  return m
}

const idle: Props = { sending: false, hasText: false, label: "Send" }

describe("ChatSendButton", () => {
  it("stays out of the way until there is something to send", async () => {
    const m = mount(idle)

    expect(m.button.classList.contains("visible")).toBe(false)
    expect(m.button.disabled).toBe(true)
    expect(m.button.tabIndex).toBe(-1)

    m.props.hasText = true
    await nextTick()

    expect(m.button.classList.contains("visible")).toBe(true)
    expect(m.button.disabled).toBe(false)
    expect(m.button.tabIndex).toBe(0)
  })

  it("stays hidden for text the composer refuses to send", () => {
    const m = mount({ ...idle, hasText: true, disabled: true })

    expect(m.button.classList.contains("visible")).toBe(false)
  })

  it("sends the composed text", () => {
    const m = mount({ ...idle, hasText: true })

    m.button.click()

    expect(m.sends).toBe(1)
    expect(m.cancels).toBe(0)
  })

  it("becomes a stop while a turn is streaming, even on an empty field", async () => {
    const m = mount({ ...idle, sending: true })

    expect(m.button.classList.contains("visible")).toBe(true)
    expect(m.button.querySelector(".dots")).not.toBeNull()
    expect(m.button.querySelector("svg")).toBeNull()

    m.button.click()
    await nextTick()

    expect(m.cancels).toBe(1)
    expect(m.sends).toBe(0)
  })

  it("carries the label the host localised", () => {
    const m = mount({ ...idle, hasText: true, label: "Отправить" })

    expect(m.button.getAttribute("aria-label")).toBe("Отправить")
  })
})
