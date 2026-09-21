// @vitest-environment jsdom
import { describe, expect, it } from "vitest"
import { blockMarkdownToHtml, inlineMarkdownToHtml } from "../markdown.js"

/** The rendered fragment as the browser would build it — the only place the
 *  difference between markup and escaped text is visible. */
function render(html: string): HTMLElement {
  const host = document.createElement("div")
  host.innerHTML = html
  return host
}

function tagNames(host: HTMLElement): string[] {
  return [...host.querySelectorAll("*")].map((el) => el.tagName.toLowerCase())
}

function eventHandlers(host: HTMLElement): string[] {
  return [...host.querySelectorAll("*")].flatMap((el) =>
    [...el.attributes].map((a) => a.name).filter((n) => n.startsWith("on"))
  )
}

describe("inlineMarkdownToHtml — what must never reach v-html", () => {
  it.each([
    ["an image with a handler", "<img src=x onerror=alert(1)>"],
    ["a script tag", "<script>alert(1)</script>"],
    ["an iframe", "<iframe src=//evil.test></iframe>"],
    ["an inline handler on a span", "<span onmouseover=alert(1)>hi</span>"],
    ["an svg handler", "<svg onload=alert(1)>"],
  ])("renders %s as text, not as a tag", (_label, payload) => {
    const host = render(inlineMarkdownToHtml(payload))
    expect(tagNames(host)).toEqual([])
    expect(eventHandlers(host)).toEqual([])
    expect(host.textContent).toContain("<")
  })

  it.each([
    ["javascript:", "[tap](javascript:alert(1))"],
    ["JaVaScRiPt:", "[tap](JaVaScRiPt:alert(1))"],
    ["data:", "[tap](data:text/html;base64,PHNjcmlwdD4=)"],
    ["vbscript:", "[tap](vbscript:msgbox(1))"],
  ])("drops a %s link, keeping its text", (_label, payload) => {
    const host = render(inlineMarkdownToHtml(payload))
    expect(host.querySelector("a")).toBeNull()
    expect(host.textContent).toContain("tap")
  })

  it("cannot break out of the href attribute", () => {
    const host = render(inlineMarkdownToHtml('[x](https://a.test/" onmouseover="alert(1))'))
    expect(eventHandlers(host)).toEqual([])
  })
})

describe("inlineMarkdownToHtml — what must still work", () => {
  it("renders emphasis, bold and code", () => {
    expect(inlineMarkdownToHtml("**b** *i* `c`")).toBe(
      "<strong>b</strong> <em>i</em> <code>c</code>"
    )
  })

  it.each([
    ["https", "[ok](https://example.test/a)", 'href="https://example.test/a"'],
    ["mailto", "[mail](mailto:a@b.test)", 'href="mailto:a@b.test"'],
    ["an anchor", "[top](#top)", 'href="#top"'],
  ])("keeps a %s link", (_label, src, href) => {
    expect(inlineMarkdownToHtml(src)).toContain(href)
  })

  it("keeps a query string's ampersand intact", () => {
    expect(inlineMarkdownToHtml("[ok](https://a.test/x?b=1&c=2)")).toContain(
      'href="https://a.test/x?b=1&amp;c=2"'
    )
  })

  // Escaping the source before parsing cost these two: `&` came back
  // re-escaped inside a code span, and `>` opened nothing.
  it("keeps a code span's contents as the author typed them", () => {
    const host = render(inlineMarkdownToHtml("use `a && b` and `<name>`"))
    expect([...host.querySelectorAll("code")].map((c) => c.textContent)).toEqual([
      "a && b",
      "<name>",
    ])
  })

  it("renders comparison operators as the characters the author typed", () => {
    expect(inlineMarkdownToHtml("5 < 6 && 7 > 2")).toBe("5 &lt; 6 &amp;&amp; 7 &gt; 2")
  })

  it("leaves transliteration and curly quotes alone", () => {
    expect(inlineMarkdownToHtml("Prabhupāda said “so”")).toBe("Prabhupāda said “so”")
  })

  it("leaves newlines for the caller's own break rules", () => {
    expect(inlineMarkdownToHtml("one\ntwo")).toBe("one\ntwo")
  })

  it("renders an empty source as nothing", () => {
    expect(inlineMarkdownToHtml("")).toBe("")
  })
})

describe("blockMarkdownToHtml", () => {
  it("renders headings and lists", () => {
    const html = blockMarkdownToHtml("# Title\n\n- one\n- two\n")
    expect(html).toContain("<h1")
    expect(html).toContain("<li>one</li>")
  })

  it("renders a table", () => {
    const html = blockMarkdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |\n")
    expect(html).toContain("<table>")
    expect(html).toContain("<td>1</td>")
  })

  it("renders a blockquote as a blockquote", () => {
    const host = render(blockMarkdownToHtml("> **Heads-up.** Import replaces the data.\n"))
    const quote = host.querySelector("blockquote")
    expect(quote).not.toBeNull()
    expect(quote?.textContent).toContain("Import replaces the data.")
    expect(quote?.querySelector("strong")?.textContent).toBe("Heads-up.")
  })

  it("keeps a table's cells addressable", () => {
    const host = render(blockMarkdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |\n"))
    expect([...host.querySelectorAll("td")].map((c) => c.textContent)).toEqual(["1", "2"])
  })

  it("renders a fenced code block as text, tags and all", () => {
    const html = blockMarkdownToHtml("```\n<b>not bold</b>\n```\n")
    expect(html).toContain("<code")
    expect(html).not.toContain("<b>not bold</b>")
  })

  it("refuses raw HTML in the source", () => {
    const host = render(blockMarkdownToHtml("Hello <img src=x onerror=alert(1)>\n"))
    expect(host.querySelector("img")).toBeNull()
    expect(eventHandlers(host)).toEqual([])
  })

  it("drops a javascript link here too", () => {
    const host = render(blockMarkdownToHtml("[tap](javascript:alert(1))\n"))
    expect(host.querySelector("a")).toBeNull()
  })
})
