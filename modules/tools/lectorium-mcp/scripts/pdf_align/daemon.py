#!/usr/bin/env python3
"""scripts/pdf_align/daemon.py — long-lived subprocess that serves PDF-derived data
to the Go side over JSON-line stdin/stdout.

Protocol:
  in:  one JSON object per line, dispatched by optional `action` field.
       Default (no `action`) = legacy align request, kept for backward compat.

       Align (action="align" or absent):
         {"pdf_path": "...", "raw_path": "...", "language": "en"}
       -> {"trackId": "...", "language": "en", "version": 2, "blocks": [...]}

       Title hint (action="title_hint"):
         {"action": "title_hint", "pdf_path": "..."}
       -> {"header_hint": "string-or-null"}

       All errors come back as {"error": "...", "traceback": "..."} on a
       single line.

The Go side spawns this once at daemon start and holds stdin/stdout pipes
for the daemon's lifetime. Per-request cost: align ~50ms, title_hint ~50ms
(both dominated by PyMuPDF parse).
"""
from __future__ import annotations
import json
import sys
import traceback
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from pdf_align import align_track, align_track_text  # noqa: E402



def handle_align(req: dict) -> dict:
    raw_path = req["raw_path"]
    language = req.get("language", "en")
    if req.get("pdf_path"):
        return align_track(req["pdf_path"], raw_path, language)
    return align_track_text(req["text_path"], raw_path, language)


def handle_title_hint(req: dict) -> dict:
    from pdf_align.titles import extract_header_hint
    pdf_path = req["pdf_path"]
    hint = extract_header_hint(pdf_path)
    return {"header_hint": hint}


HANDLERS = {
    "align": handle_align,
    "title_hint": handle_title_hint,
}


def main() -> int:
    out = sys.stdout
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except (ValueError, TypeError) as e:
            out.write(json.dumps({"error": f"bad request: {e}"}) + "\n")
            out.flush()
            continue

        action = req.get("action") or "align"
        handler = HANDLERS.get(action)
        if handler is None:
            out.write(json.dumps({"error": f"unknown action: {action}"}) + "\n")
            out.flush()
            continue

        try:
            result = handler(req)
        except KeyError as e:
            out.write(json.dumps({"error": f"missing field: {e}"}) + "\n")
            out.flush()
            continue
        except Exception as e:
            out.write(json.dumps({
                "error": f"{type(e).__name__}: {e}",
                "traceback": traceback.format_exc(),
            }) + "\n")
            out.flush()
            continue

        out.write(json.dumps(result, ensure_ascii=False) + "\n")
        out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
