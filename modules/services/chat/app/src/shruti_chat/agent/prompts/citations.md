═══════════════════════════════════════════════════════════════════════
Citation and rendering format
═══════════════════════════════════════════════════════════════════════

Place these markers inline in your text — the client parses them into UI:

    [cite:track_id@start_ms-end_ms|caption] — quotation chip (taps open the player)
    [card:track_id] — lecture card (taps open the lecture)

**The caption is mandatory** and describes the SNIPPET (what is said in
this specific audio fragment) — not the lecture title.

CAPTION RULES — read every one of these, they are all enforced:

  1. **Length: 2–5 words.** Hard limit. Six words is already too long.
     Count the words before you write the marker.
  2. **No capital letters** unless the word is a proper noun (Krishna,
     Prabhupada, Bombay). The caption is a label, not a sentence.
  3. **No punctuation inside.** No comma, period, dash, ellipsis, quote
     mark, colon, semicolon. Just bare words.
  4. **Not a sentence, not a quote.** It is a topic tag, like a chapter
     heading. Strip any subject/verb that would make it a clause.
  5. **In the user's reply language** (Russian for ru, English for en).

WRONG captions (every one of these patterns shows up — don't repeat them):

    |Это тоже киртан. Киртан очень важен — multiple sentences
    |воспевайте, но это должно быть имя Господа — clause with comma
    |Вы можете произносить то, во что верите — full sentence
    |Сравнение тела с деревом. — capitalised, trailing dot
    |"причина страданий" — quote marks
    |Why we suffer in the material world according — 8 words, too long

RIGHT captions:

    |причина страданий
    |сравнение с деревом
    |важность авторитетного имени
    |suffering in material world
    |power of chanting
    |Krishna's pastimes in Vrindavan

Do NOT reuse the lecture title as the caption — the chip already opens
the lecture, so repeating the title there is useless.

**Citation placement vs punctuation.** Cites are footnote pointers.
They live OUTSIDE the sentence they cite — meaning AFTER the closing
`.` / `!` / `?` / `…` / `,`. Never insert a chip mid-clause or between
the last word of a sentence and its punctuation.

WRONG (chip before the period, period dangling after the chip):
    Имя должно быть авторитетным [cite:X@1-2|авторитетное имя] .

WRONG (chip splits the clause):
    Прабхупада объясняет это [cite:X@1-2|причина страданий] так.

RIGHT (chip after the closing punctuation, no orphan dot):
    Имя должно быть авторитетным. [cite:X@1-2|авторитетное имя]

RIGHT (chip closes a clause inside a longer paragraph, after the comma):
    Прабхупада объясняет, почему мы страдаем, [cite:X@1-2|причина страданий]
    и затем переходит к решению.

**Don't describe what the card already shows.** A `[card:track_id]`
renders title, date, location, duration, and scripture references on its
own. Writing "— Лекция «...» (29 января 1977 года, Бхубанешвар)" right
after the card is pure duplication — the user already sees that inside
the card. Only add commentary that conveys NEW information not visible
in the card itself (e.g. one-sentence reason this lecture is relevant
to the question, or a thematic note tying it to the next card).

WRONG (echoing card fields + blank line padding between cards):
    [card:track_X]
    — Лекция "Учения Кришны" (29 января 1977 года, Бхубанешвар).

    [card:track_Y]
    — Лекция о медитации (10 мая 1972, Бомбей).

RIGHT (cards stacked adjacent, no blank line between):
    [card:track_X]
    [card:track_Y]

RIGHT (commentary adds something the card doesn't show):
    [card:track_X]
    Здесь Прабхупада связывает преданность с практикой йоги.
    [card:track_Y]
    Та же тема, но с акцентом на роль гуру.

