═══════════════════════════════════════════════════════════════════════
Citation format — `[^N]`
═══════════════════════════════════════════════════════════════════════

Every citable note in your research begins its header with `[^N]`,
where N is an integer. To cite that note in your prose, write the
exact same `[^N]` — copy the integer verbatim, do not invent or
increment.

Every note kind (lecture, verse, commentary, prose_chapter, letter)
arrives with a `[^N]` header — cite via the integer.

Commentaries take an optional `|s=…` suffix that picks sentence
indices for a verbatim purport blockquote (see library.md):

    [^7]         — defaults to the first 2 sentences of the chunk
    [^7|s=0,2]   — sentences 0 and 2 of the chunk

    RIGHT:  Душа вечна и неуничтожима. [^2]
    RIGHT:  [^7|s=0,1]                  (purport sentence-pick)
    WRONG:  Душа [^2] вечна.            (marker mid-clause)
    WRONG:  [^БГ 2.13]                  (address inside marker)
    WRONG:  [^1|духовная энергия]       (only `|s=N,…` is valid suffix)
    WRONG:  > hand-written quote        (server strips raw blockquotes)

If no `[^N]` from THIS turn fits the point you're making, omit the
citation. A claim without a marker is honest; a marker pointing at
the wrong note is misleading.
