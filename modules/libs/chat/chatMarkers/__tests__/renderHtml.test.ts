import { describe, expect, it } from "vitest"
import { inlineMd, normalizeQuoteBreaks, pushTextToken, renderExcerptHtml } from "../renderHtml.js"
import type { ChatToken } from "../parse.js"

function render(raw: string): string | null {
  const out: ChatToken[] = []
  pushTextToken(out, raw)
  const tok = out[0]
  return tok && tok.kind === "text" ? tok.html : null
}

describe("inlineMd", () => {
  it("renders emphasis and bold", () => {
    expect(inlineMd("*bhakti* and **jnana**")).toBe("<em>bhakti</em> and <strong>jnana</strong>")
  })

  it("leaves prose that contains no markdown untouched", () => {
    expect(inlineMd("plain words")).toBe("plain words")
  })
})

describe("pushTextToken — prose", () => {
  it("has nothing to push for an empty run", () => {
    const out: ChatToken[] = []
    pushTextToken(out, "")

    expect(out).toEqual([])
  })

  it("turns markdown bullets into a real bullet glyph", () => {
    expect(render("* first\n* second")).toBe("• first<br>• second")
  })

  it("accepts either bullet character the model may use", () => {
    expect(render("- dash\n+ plus")).toBe("• dash<br>• plus")
  })

  it("keeps emphasis inside a bullet", () => {
    expect(render("* **bold** item")).toBe("• <strong>bold</strong> item")
  })

  it("renders a blank line as a paragraph break and a single one as a soft break", () => {
    expect(render("one\n\ntwo\nthree")).toBe("one<br><br>two<br>three")
  })

  it("closes up the double spaces the model leaves after a full stop", () => {
    expect(render("One.  Two.")).toBe("One. Two.")
  })
})

describe("pushTextToken — headings", () => {
  it("draws an atx heading as its own header element", () => {
    expect(render("## The soul")).toBe('<h2 class="chat-header">The soul</h2>')
  })

  it("keeps emphasis inside a heading", () => {
    expect(render("## The **soul**")).toBe('<h2 class="chat-header">The <strong>soul</strong></h2>')
  })

  it("does not leave a blank gap stacked on a heading's own margin", () => {
    expect(render("Intro.\n\n## The soul\n\nBody.")).toBe(
      'Intro.<h2 class="chat-header">The soul</h2>Body.'
    )
  })

  it("renders several headings with their prose between them", () => {
    expect(render("## One\n\nA.\n\n## Two\n\nB.")).toBe(
      '<h2 class="chat-header">One</h2>A.<h2 class="chat-header">Two</h2>B.'
    )
  })

  it("leaves an underlined prose line alone rather than eating it", () => {
    const html = render("Just a line\n---")

    expect(html).not.toContain("<h2")
    expect(html).toContain("Just a line")
  })
})

describe("normalizeQuoteBreaks", () => {
  it("collapses the blank lines a purport puts between stanza lines", () => {
    expect(normalizeQuoteBreaks("line one\n\nline two")).toBe("line one\nline two")
  })

  it("normalises windows line endings", () => {
    expect(normalizeQuoteBreaks("line one\r\nline two")).toBe("line one\nline two")
  })

  it("leaves a single break alone", () => {
    expect(normalizeQuoteBreaks("line one\nline two")).toBe("line one\nline two")
  })
})

describe("renderExcerptHtml", () => {
  it("has nothing to render for an empty excerpt", () => {
    expect(renderExcerptHtml("")).toBe("")
  })

  it("renders plain excerpt prose through the inline pipeline", () => {
    expect(renderExcerptHtml("The soul is **eternal**.")).toBe(
      "The soul is <strong>eternal</strong>."
    )
  })

  it("lifts a quoted shloka into its own quote block", () => {
    expect(renderExcerptHtml("> dehino 'smin")).toBe(
      '<blockquote class="excerpt-quote">dehino &#39;smin</blockquote>'
    )
  })

  it("peels the italic wrapper off a quoted transliteration", () => {
    expect(renderExcerptHtml("> *dehino 'smin*")).toBe(
      '<blockquote class="excerpt-quote">dehino &#39;smin</blockquote>'
    )
  })

  it("keeps emphasis that only covers part of the quote", () => {
    expect(renderExcerptHtml("> *dehino* smin")).toBe(
      '<blockquote class="excerpt-quote"><em>dehino</em> smin</blockquote>'
    )
  })

  it("keeps the prose on both sides of a quoted verse", () => {
    const html = renderExcerptHtml("As it says:\n> dehino 'smin\nand so on.")

    expect(html).toBe(
      'As it says:<blockquote class="excerpt-quote">dehino &#39;smin</blockquote>and so on.'
    )
  })

  it("joins the lines of a multi-line quote inside one block", () => {
    expect(renderExcerptHtml("> line one\n> line two")).toBe(
      '<blockquote class="excerpt-quote">line one<br>line two</blockquote>'
    )
  })

  it("renders no literal angle bracket for a quoted line", () => {
    expect(renderExcerptHtml("> dehino 'smin")).not.toContain("&gt;")
  })
})
