import { describe, expect, it } from "vitest"
import { ref } from "vue"
import { useTranslatable, type TranslatableBody } from "../useTranslatable.js"

describe("useTranslatable", () => {
  it("shows the translated text until the reader asks for the original", () => {
    const { isMt, showOriginal, displayText } = useTranslatable(() => ({
      text: "Хранитель вселенной",
      mt: true,
      textOriginal: "The maintainer of the universe",
    }))

    expect(isMt.value).toBe(true)
    expect(displayText.value).toBe("Хранитель вселенной")

    showOriginal.value = true

    expect(displayText.value).toBe("The maintainer of the universe")
  })

  it("offers no toggle for text that was never translated", () => {
    const { isMt, showOriginal, displayText } = useTranslatable(() => ({ text: "As it is" }))

    expect(isMt.value).toBe(false)

    showOriginal.value = true

    expect(displayText.value).toBe("As it is")
  })

  it("offers no toggle when the original was not carried along", () => {
    const { isMt, showOriginal, displayText } = useTranslatable(() => ({
      text: "Хранитель вселенной",
      mt: true,
    }))

    expect(isMt.value).toBe(false)

    showOriginal.value = true

    expect(displayText.value).toBe("Хранитель вселенной")
  })

  it("renders nothing for a card whose body has not arrived", () => {
    const { isMt, displayText } = useTranslatable(() => null)

    expect(isMt.value).toBe(false)
    expect(displayText.value).toBe("")
  })

  it("follows the body the host swaps in", () => {
    const body = ref<TranslatableBody | null>(null)
    const { isMt, displayText } = useTranslatable(() => body.value)

    body.value = { text: "перевод", mt: true, textOriginal: "original" }

    expect(isMt.value).toBe(true)
    expect(displayText.value).toBe("перевод")
  })
})
