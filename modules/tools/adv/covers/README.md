# covers

Generate 9:16 Shorts covers. Two steps:

1. `gen_gemini.py prompt.txt out.png ref.jpg` — restyle a real photo/frame
   through OpenRouter's Gemini image model into the brand look (needs
   `OPENROUTER_API_KEY`).
2. `make_cover.py config.json` — compose the final cover with Pillow: the
   image + a question caption in Manrope, anchored on a FIXED vertical
   center (`text_center`) with line advance from font metrics, so the
   caption sits at the exact same height on every cover.

config.json:
{ "image": "...", "out": "...", "text_center": 1650,
  "grad_start": 1180, "grad_strength": 225,
  "lines": [ {"text":"...","font":"fonts/Manrope-var.ttf","axes":[800],
              "size":76,"color":[250,245,234],"stroke":7,"gap":8}, ... ] }
