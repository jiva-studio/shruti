#!/usr/bin/env python3
"""scripts/sentencesplit/razdel.py — long-lived subprocess that segments Russian/English
text into sentences via the razdel library.

Protocol: JSON-line stdin → JSON-line stdout.
  in:  {"text": "Привет, мир. Как дела?"}
  out: [{"start":0,"stop":12,"text":"Привет, мир."}, ...]

The Go side spawns this once at daemon start and holds stdin/stdout
pipes for the lifetime of the daemon. razdel is single-threaded and
deterministic; the Go adapter serializes calls.

Russian sentence segmentation is non-trivial: abbreviations (т.е.,
А.Ч.), initials (Шри И.), numbered lists, decimals (БГ 8.13), and
embedded Sanskrit verses in quotes all break naive punctuation
splitting. razdel encodes ~500 hand-tuned rules from the Natasha NLP
project and handles these correctly out of the box.
"""

import json
import sys

from razdel import sentenize


def main() -> int:
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            text = req.get("text", "")
        except (ValueError, TypeError) as e:
            out.write(json.dumps({"error": f"bad request: {e}"}) + "\n")
            out.flush()
            continue

        sents = [
            {"start": s.start, "stop": s.stop, "text": s.text}
            for s in sentenize(text)
        ]
        out.write(json.dumps(sents, ensure_ascii=False) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
