from airflow.decorators import task

from lectorium.tracks_inbox.models.track_inbox import TrackInbox
from lectorium.tracks.models.track import Track


# @task(
#     task_display_name="💾 Prepare Track",
#     trigger_rule="none_failed")
def prepare_track_document(
    track_id: str,
    inbox_track: TrackInbox,
    audio_file_original_url: str,
    audio_file_normalized_url: str,
    languages_in_audio_file: list[str],
    languages_translated_into: list[str],
) -> Track:
    date_to_save = inbox_track["date"].get("normalized", []) or []
    date_to_save = list(filter(None, date_to_save)) or None

    document = {
        "_id": track_id,
        "version": 1,
        "audioUrl": {
            "original": audio_file_original_url,
            "normalized": audio_file_normalized_url,
        },
        "title": {
            lang: inbox_track["title"]["normalized"]
            for lang in languages_in_audio_file
        },
        "location": inbox_track["location"]["normalized"],
        "date": date_to_save,
        "author": inbox_track["author"]["normalized"],
        "file_size": inbox_track["file_size"],
        "duration": inbox_track["duration"],
        "references": [r["normalized"] for r in inbox_track["references"]],
        "languages":
            [ # original language in audio file
                {"language": lang, "source": "track", "type": "original"}
                for lang in languages_in_audio_file
            ] + [ # original language in audio file for which transcript is generated
                {"language": lang, "source": "transcript", "type": "generated"}
                for lang in languages_in_audio_file
            ] + [ # transcript translated into other languages
                {"language": lang, "source": "transcript", "type": "generated"}
                for lang in languages_translated_into
            ]
    }

    if not document.get("location", None):
        del document["location"]

    # TODO: App is not ready for that yet
    #       once it is ready, we can uncomment this
    # if not document.get("date", None):
    #     del document["date"]

    # if not document.get("references", None):
    #     del document["references"]

    return document