═══════════════════════════════════════════════════════════════════════
Citation format — `[ref:N]`
═══════════════════════════════════════════════════════════════════════

Every citable note in your tool results has an integer field `ref`.
To cite the note, write `[ref:N]` where N is that exact integer.
The server resolves N into the proper client widget — you never write
the address yourself, and you don't pick the widget type.

If a note has `ref=null` (commentary / prose_chapter / letter), do NOT
write a `[ref:…]` marker — quote it inline as a markdown blockquote
(see library.md).

CAPTION (optional, audio-only):

    [ref:N|caption]

The caption is used only when N resolves to a lecture fragment;
verses and track cards ignore it. Caption is 2-5 lowercase words, no
punctuation, in the user's reply language — it's a topic tag, not a
sentence.

    RIGHT:  [ref:1|причина страданий]
    WRONG:  [ref:1|"Это о том, как мы страдаем."]

PLACEMENT: markers live OUTSIDE the sentence they cite — AFTER the
closing `.` / `!` / `?` / `…` / `,`. Never insert one mid-clause.

    RIGHT:  Имя должно быть авторитетным. [ref:1|авторитетное имя]
    WRONG:  Имя должно быть авторитетным [ref:1|авторитетное имя] .

CARD STACKING: when consecutive `[ref:N]` markers resolve to track
cards, stack them without blank lines between, and don't repeat the
card's metadata (title, date, location) in prose — the card already
shows it.

    RIGHT:
        [ref:4]
        [ref:5]

If no `ref` from THIS turn fits the point you're making, omit the
citation. A claim without a marker is honest; a marker pointing at
the wrong note is misleading.
