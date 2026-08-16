// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { createApp, h, nextTick, ref, type Ref } from "vue"

import FloatingInput from "../FloatingInput.vue"

/**
 * Who owns the text (#1885).
 *
 * `submit()` empties the field only when the caller did not bind one, and the
 * keystroke watcher used to decide that by looking at `model.value`. But
 * `defineModel` hands back a writable ref whether or not anyone bound it, so
 * the first typed character made the model defined and the field looked owned
 * from then on: the question stayed in the composer after it was sent, and the
 * next Enter — or the next tap on send, same path — spent another chat turn on
 * the identical text. Every conversation caller (the app's `ChatInputBar`, the
 * site's `ChatApp`/`GitaAiChat`) mounts this with no `v-model`; the library
 * search bar is the one caller that does bind, and its text must survive.
 */

type Mounted = { el: HTMLTextAreaElement; sent: string[] }

function mountUnbound(): Mounted {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const sent: string[] = []
  createApp({
    render: () =>
      h(FloatingInput, { placeholder: "ask", onSubmit: (text: string) => sent.push(text) }),
  }).mount(host)
  return { el: host.querySelector("textarea") as HTMLTextAreaElement, sent }
}

function mountBound(initial: string): Mounted & { model: Ref<string> } {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const sent: string[] = []
  const model = ref(initial)
  createApp({
    render: () =>
      h(FloatingInput, {
        placeholder: "search",
        modelValue: model.value,
        "onUpdate:modelValue": (next: string) => (model.value = next),
        onSubmit: (text: string) => sent.push(text),
      }),
  }).mount(host)
  return { el: host.querySelector("textarea") as HTMLTextAreaElement, sent, model }
}

/** One keystroke's worth of change, the way `v-model` on a textarea sees it. */
async function type(el: HTMLTextAreaElement, value: string): Promise<void> {
  el.value = value
  el.dispatchEvent(new Event("input"))
  await settle()
}

async function pressEnter(el: HTMLTextAreaElement, init: KeyboardEventInit = {}): Promise<void> {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ...init }))
  await settle()
}

/** The field re-measures itself on a nextTick, so its state settles one behind. */
async function settle(): Promise<void> {
  await nextTick()
  await nextTick()
}

describe("FloatingInput", () => {
  it("empties itself once the text is away", async () => {
    const { el, sent } = mountUnbound()

    await type(el, "who am i")
    await pressEnter(el)

    expect(sent).toEqual(["who am i"])
    expect(el.value).toBe("")
  })

  it("has nothing left to send on a second Enter", async () => {
    const { el, sent } = mountUnbound()

    await type(el, "who am i")
    await pressEnter(el)
    await pressEnter(el)

    // The second press is what used to buy a duplicate, quota-counted turn.
    expect(sent).toEqual(["who am i"])
  })

  it("sends through the slot's submit and clears just the same", async () => {
    // The send button lives in the caller's slot and calls the `submit` it is
    // handed, so the button path must not differ from the Enter path.
    const host = document.createElement("div")
    document.body.appendChild(host)
    const sent: string[] = []
    createApp({
      render: () =>
        h(
          FloatingInput,
          { placeholder: "ask", onSubmit: (text: string) => sent.push(text) },
          {
            action: ({ submit }: { submit: () => void }) =>
              h("button", { class: "send", onClick: () => submit() }),
          }
        ),
    }).mount(host)
    const el = host.querySelector("textarea") as HTMLTextAreaElement

    await type(el, "where did i stop")
    ;(host.querySelector("button.send") as HTMLButtonElement).click()
    await settle()

    expect(sent).toEqual(["where did i stop"])
    expect(el.value).toBe("")
  })

  it("leaves an Enter that commits an IME candidate to the composition", async () => {
    const { el, sent } = mountUnbound()

    await type(el, "みかん")
    await pressEnter(el, { isComposing: true })
    expect(sent).toEqual([])

    // Engines that never set the flag report the composition keyCode instead.
    await pressEnter(el, { keyCode: 229 })
    expect(sent).toEqual([])

    // Once the candidate is committed the very same key sends.
    await pressEnter(el)
    expect(sent).toEqual(["みかん"])
  })

  it("keeps the text a caller bound with v-model", async () => {
    // The library search bar searches as you type and deliberately holds on to
    // the query; clearing is its cross button's job, not submit's.
    const { el, sent, model } = mountBound("")

    await type(el, "bhakti")
    expect(model.value).toBe("bhakti")

    await pressEnter(el)

    expect(sent).toEqual(["bhakti"])
    expect(el.value).toBe("bhakti")
    expect(model.value).toBe("bhakti")
  })

  it("follows a bound caller that rewrites the query under it", async () => {
    const { el, model } = mountBound("bhakti")

    model.value = "jnana"
    await settle()

    expect(el.value).toBe("jnana")
  })
})
