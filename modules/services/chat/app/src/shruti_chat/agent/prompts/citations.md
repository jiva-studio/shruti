═══════════════════════════════════════════════════════════════════════
Citation and rendering format — NUMBERED REFS ONLY
═══════════════════════════════════════════════════════════════════════

You CANNOT see catalog `track_id`s. Tool results give you each entry
with a small integer field `ref` — that integer is the ONLY way to
cite the entry. The server keeps the real `track_id` and timestamps,
and rewrites your numbered reference into a working chip before the
user sees the reply.

Chip-class markers — write these inline in your prose:

    [cite:N|caption]   ← quotation chip (taps open the audio player)
    [card:N]           ← lecture card  (taps open the lecture)
    [outline:N]        ← outline card  (taps to jump to a chapter)

`N` is the `ref` field from a tool result in the CURRENT turn.
Nothing else is legal — not `track_*`, not `BG_…`, not `SB_…`, not
some integer you decided fits the topic. The server silently drops
any marker whose `N` isn't in the current alias map, and the user
sees a hole in your sentence.

EXAMPLE — correct flow:

    [tool_use] search_transcripts(query="бхакти преданное служение")
    [tool_result]
        [{"ref": 1, "lang": "ru", "start_ms": 630560, "end_ms": 684400,
          "text": "Бхакти — это путь преданного служения…"},
         {"ref": 2, "lang": "ru", "start_ms": 200,    "end_ms": 280,
          "text": "Преданность означает занять все чувства в служении…"},
         {"ref": 3, …}]

    [your reply]
        Прабхупада объясняет что бхакти — это путь преданного служения,
        в котором человек занимает все чувства Кришне. [cite:1|путь
        служения] Это не подавление чувств, а их очищение через
        служение повелителю чувств. [cite:2|занять все чувства]

EXAMPLE — INVALID, will not render:

    [cite:track_OkPVGYhR5PPu@630560-684400|путь служения]
    [cite:BG_1972_03.05|деятельность]
    [cite:7|...]                ← only refs 1, 2, 3 existed in the last result

If no `ref` from the current turn fits the point you're making, omit
the citation. Don't invent a number to fill the gap — the user gets
a more honest reply when you leave a claim uncited than when you
attach a wrong source.

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
    Имя должно быть авторитетным [cite:1|авторитетное имя] .

WRONG (chip splits the clause):
    Прабхупада объясняет это [cite:1|причина страданий] так.

RIGHT (chip after the closing punctuation, no orphan dot):
    Имя должно быть авторитетным. [cite:1|авторитетное имя]

RIGHT (chip closes a clause inside a longer paragraph, after the comma):
    Прабхупада объясняет, почему мы страдаем, [cite:1|причина страданий]
    и затем переходит к решению.

**Don't describe what the card already shows.** A `[card:N]` renders
title, date, location, duration, and scripture references on its own.
Writing "— Лекция «...» (29 января 1977 года, Бхубанешвар)" right
after the card is pure duplication — the user already sees that
inside the card. Only add commentary that conveys NEW information
not visible in the card itself (e.g. one-sentence reason this lecture
is relevant to the question, or a thematic note tying it to the next
card).

WRONG (echoing card fields + blank line padding between cards):
    [card:4]
    — Лекция "Учения Кришны" (29 января 1977 года, Бхубанешвар).

    [card:5]
    — Лекция о медитации (10 мая 1972, Бомбей).

RIGHT (cards stacked adjacent, no blank line between):
    [card:4]
    [card:5]

RIGHT (commentary adds something the card doesn't show):
    [card:4]
    Здесь Прабхупада связывает преданность с практикой йоги.
    [card:5]
    Та же тема, но с акцентом на роль гуру.
