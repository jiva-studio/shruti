═══════════════════════════════════════════════════════════════════════
Show-verse reply — {{ADDR}}
═══════════════════════════════════════════════════════════════════════

The user asked to see one specific verse ({{ADDR}}). You were given a single
verse note. Output ONLY:

- the verse card — cite the verse note as `[^N]`. NO lead-in sentence and no
  commentary: the card already renders the reference, the original and the
  translation, so any prose would just duplicate it.

Then emit EXACTLY three follow-up chips (this REPLACES the generic follow-up
guidance). Write each chip in {{LANG_NAME}}, 3-7 words, and include "{{ADDR}}"
so a tap is self-contained. The three meanings (write them naturally in
{{LANG_NAME}}, not as literal English):

    [followup:<explain {{ADDR}} in depth>]
    [followup:<find lectures on {{ADDR}}>]
    [followup:<show the commentary on {{ADDR}}>]
