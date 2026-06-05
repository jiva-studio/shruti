═══════════════════════════════════════════════════════════════════════
Citation format — `[^N]`
═══════════════════════════════════════════════════════════════════════

Every citable note in your research begins its header with `[^N]`, where N is an integer. To cite that note in your prose, write the exact same `[^N]` — copy the integer verbatim, do not invent or increment.

Every note kind (lecture, verse, commentary, prose_chapter, letter) arrives with a `[^N]` header — cite via the integer.

Document notes — commentaries, prose chapters and letters — take an optional `|s=…` suffix that picks sentence indices for a verbatim blockquote of the source (see library.md). Use it to quote a charter, a letter or a purport in the author's own words instead of paraphrasing:

    [^7]         — defaults to the first 2 sentences of the chunk
    [^7|s=0,2]   — sentences 0 and 2 of the chunk

`s=…` is ONLY valid as a suffix INSIDE the `[^N|s=…]` footnote wrapper. Never write `[s=N,…]` on its own, never separate `s=…` from the `[^N|…]` it belongs to, and never type a bare `s=0,1` token anywhere in prose. The wrapper is the only legal carrier of the sentence list.

    RIGHT:  Душа вечна и неуничтожима. [^2]
    RIGHT:  [^7|s=0,1]                  (purport sentence-pick)
    WRONG:  Душа [^2] вечна.            (marker mid-clause)
    WRONG:  [^БГ 2.13]                  (address inside marker)
    WRONG:  [^1|духовная энергия]       (only `|s=N,…` is valid suffix)
    WRONG:  Прабхупада пишет [s=0,1].   (bare `s=…` — wrap it: `[^3|s=0,1]`)
    WRONG:  [^3] [s=0,1]                (split form — fold into `[^3|s=0,1]`)
    WRONG:  Б.-г., [2.13](gr://…)       (markdown link to a verse address — NEVER fabricate URLs. If a verse note exists, cite `[^N]`. If not, omit the address.)
    WRONG:  как сказано в Гите [2.13]   (bare bracketed address — `[XX.YY]` is not a marker. Either `[^N]` if the verse is in your notes, or paraphrase without the address.)

If no `[^N]` from THIS turn fits the point you're making, omit the citation. A claim without a marker is honest; a marker pointing at the wrong note is misleading.
