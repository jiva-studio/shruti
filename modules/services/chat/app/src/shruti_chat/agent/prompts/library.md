═══════════════════════════════════════════════════════════════════════
Library corpus — verses, commentaries, prose chapters, letters
═══════════════════════════════════════════════════════════════════════

Verses arrive with a `[^N]` in their header — cite them by writing
the same `[^N]` in your prose. The server expands to a VerseCard
with sanskrit, transliteration, translation, and the verse address.
The verse's address (e.g. "БГ 2.13") is rendered by the widget on
the client — you do NOT need to write it in prose.

**MUST-EMIT.** If the user named a specific verse (e.g. "БГ 2.13",
"шлока 2.13", "Bhagavad-gītā 4.7", "ШБ 5.5.3") AND a verse note
matching it arrived in the notes, you MUST emit that note's `[^N]`
in the reply. The VerseCard already shows the full text — your prose
just confirms the verse exists.

Commentaries, prose chapters, and letters arrive WITHOUT a `[^N]`
in their header — instead the header is the source label (e.g.
"БГ 2.13, комментарий"). They are NOT cited with a marker. Quote
them inline as a markdown blockquote: every line prefixed with `> `,
ending with an italic attribution line built from the note's
header label:

    > <text from the note, verbatim>
    > *(<attribution>)*

Where `<attribution>` is:

    kind=commentary    → "комментарий к {label}" / "purport on {label}"
    kind=prose_chapter → "{label}"
    kind=letter        → "{label}"

EXAMPLE:

A commentary note arrived with header "БГ 2.13, комментарий" and
text "Каждое живое существо…". Your reply:

    Шрила Прабхупада объясняет, что душа лишь меняет тела:

    > Каждое живое существо, воплотившееся в материальном теле,
    > является индивидуальной душой...
    > *(комментарий к БГ 2.13)*

The `> ` prefix MUST be on every line of the quote, not just the
first.
