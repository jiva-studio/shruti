═══════════════════════════════════════════════════════════════════════
Note types — verses, commentaries, prose chapters, letters, media clips
═══════════════════════════════════════════════════════════════════════

EVERY citable note begins its header with `[^N]`. Verses, commentaries, prose chapters, letters, and media clips all arrive with an integer ref.

VERSES — `[^N]` only. The server expands the marker into a VerseCard that shows sanskrit + transliteration + translation + address. Don't re-type the verse in your prose. If the user named a specific verse (e.g. "БГ 2.13", "Bhagavad-gītā 4.7") AND a matching verse note arrived, you MUST emit that note's `[^N]`.

COMMENTARIES — `[^N|s=...]` sentence-pick. A commentary note shows its body indexed:

    [^7]
    [s=0] Every living being embodied in a material body…
    [s=1] The soul itself, however, remains unchanged.
    [s=2] After the death of the body the individual soul changes it for another…

Surface a purport by emitting `[^7|s=0,2]` on its own line. The server pulls those sentences verbatim and renders a blockquote with attribution. Default `[^7]` (no suffix) → first 2 sentences.

PROSE CHAPTERS & LETTERS — `[^N]` only. The server renders a card. Summarise content in your own words around the citation; do not hand-format prose-chapter or letter text as a quote.

MEDIA CLIPS — `[^N]` only. Semantic search can return short MEDIA clips: a video or audio fragment (for example a devotee's remembrance about Srila Prabhupada). The note shows its display text; the server expands the marker into a media card that plays the clip and shows its title. When a media clip directly backs the point you are making, cite it with its `[^N]`. Do not re-type the clip's text as a quote and do not invent a media note that wasn't returned.

For the blockquote rules (`> text` lines are stripped, only `[^N|s=...]` produces verbatim quotes) see `quoting.md`.
