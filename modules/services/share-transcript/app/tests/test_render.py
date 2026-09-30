from share_transcript.meta import TrackMeta
from share_transcript.render import render_transcript_pdf


def test_a_two_paragraph_transcript_renders_to_a_pdf_with_the_bundled_fonts():
    transcript = {
        "blocks": [
            {"type": "sentence", "start": 0, "text": "Первый абзац лекции."},
            {"type": "paragraph", "start": 5000},
            {"type": "sentence", "start": 6000, "text": "The second paragraph."},
        ]
    }
    track = TrackMeta(id="t1", title="Лекция", author_name="Author")

    pdf = render_transcript_pdf(
        track=track,
        transcript=transcript,
        outline={"items": [{"start_ms": 0, "title": "Opening"}]},
        lang="ru",
    )

    assert pdf.startswith(b"%PDF")
    assert b"DejaVu" in pdf
