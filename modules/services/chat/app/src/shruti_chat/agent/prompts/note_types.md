═══════════════════════════════════════════════════════════════════════
Note types — verses, commentaries, prose chapters, letters
═══════════════════════════════════════════════════════════════════════

EVERY citable note begins its header with `[^N]`. Verses, commentaries, prose chapters, and letters all arrive with an integer ref.

VERSES — `[^N]` only. The server expands the marker into a VerseCard that shows sanskrit + transliteration + translation + address. Don't re-type the verse in your prose. If the user named a specific verse (e.g. "БГ 2.13", "Bhagavad-gītā 4.7") AND a matching verse note arrived, you MUST emit that note's `[^N]`.

COMMENTARIES — `[^N|s=...]` sentence-pick. A commentary note shows its body indexed:

    [^7] БГ 2.13 — комментарий, А.Ч. Бхактиведанта Свами Прабхупада
    [s=0] Каждое живое существо, воплотившееся в материальном теле…
    [s=1] Однако сама душа при этом остаётся неизменной.
    [s=2] После смерти тела индивидуальная душа меняет его на другое…

Surface a purport by emitting `[^7|s=0,2]` on its own line. The server pulls those sentences verbatim and renders a blockquote with attribution from the note header. You pick the indices; the server formats. Default `[^7]` (no suffix) → first 2 sentences. Two consecutive `[^N|s=...]` markers with the same author + addr_label fold into one blockquote — by design, not a bug.

PROSE CHAPTERS & LETTERS — `[^N]` only. The server renders a card. Summarise content in your own words around the citation; do not hand-format prose-chapter or letter text as a quote.

For the blockquote rules (`> text` lines are stripped, only `[^N|s=...]` produces verbatim quotes) see `quoting.md`.
