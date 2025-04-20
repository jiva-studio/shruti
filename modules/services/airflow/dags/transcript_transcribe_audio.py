from __future__ import annotations

from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from lectorium.transcripts import Transcript, TranscriptBlock
from lectorium.shared import LANGUAGE_PARAMS

from lectorium.deepgram import deepgram_transcribe_audio_file
from lectorium.bucket import bucket_sign_url, bucket_upload_data
from lectorium.shared import set_dag_run_note


@dag(
  dag_display_name="📜 Trascript: Transcribe Audio",
  description="Transcribes audio for a given audio file and uploads artifacts to the bucket.",
  start_date=datetime(2021, 1, 1),
  schedule=None,
  catchup=False,
  tags=["lectorium", "tracks", "transcripts"],
  dagrun_timeout=timedelta(hours=32),
  default_args={
    "owner": "Advaita Krishna das",
  },
  render_template_as_native_obj=True,
  params={
    "track_id": Param(
      default="",
      description="Track ID to process",
      type="string",
      title="#️⃣ Track ID",
    ),
    "audio_type": Param(
      default="original",
      description="Type of audio to process",
      title="🎙️ Audio Type",
      type="string",
      enum=["original", "normalized", "speaker_1", "speaker_2", "speaker_3"],
      values_display={
        "original": "📼 Original",
        "normalized": "💿 Normalized",
        "speaker_1": "🗣️ Speaker 1",
        "speaker_2": "🗣️ Speaker 2",
        "speaker_3": "🗣️ Speaker 3",
      },
    ),
    "language": Param(
      default="en",
      description="Extract transcript in the given language",
      title="Language",
      **LANGUAGE_PARAMS,
    ),
  },
)
def transcript_transcribe_audio():
  """
  Transcribes audio for a given audio file and uploads artifacts to the bucket.

  #### Input Parameters:
  - `track_id`: Track ID to process
  - `audio_type`: Type of audio to process: `original` or `normalized` or isolated speaker
  - `language`: Extract transcript in the given language

  #### Input File:
  - `library/tracks/{track_id}/audio/{audio_type}.mp3`: Audio file to process
  - `library/tracks/{track_id}/artifacts/diarization/{audio_type}.mp3`: Isolated speaker audio file

  #### Outputs:
  - `library/tracks/{track_id}/artifacts/transcripts/{language}/raw_response.json`: Raw response from the API
  - `library/tracks/{track_id}/artifacts/transcripts/{language}/original.json`: Extracted transcript
  """

  # ---------------------------------------------------------------------------- #
  #                                     Config                                   #
  # ---------------------------------------------------------------------------- #

  conf_track_id   = "{{ params.track_id }}"
  conf_language   = "{{ params.language }}"
  conf_audio_type = "{{ params.audio_type }}"
  conf_language   = "{{ params.language }}"

  conf_bucket_key_raw_response = "{{ 'library/tracks/' ~ params.track_id ~ '/artifacts/transcripts/' ~ params.language ~ '/raw/deepgram_response.json' }}"
  conf_bucket_key_transcript   = "{{ 'library/tracks/' ~ params.track_id ~ '/artifacts/transcripts/' ~ params.language ~ '/original.json' }}"


  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(task_display_name="🔍 Get Audio File Object Key", multiple_outputs=False)
  def get_audio_file_object_key(
    track_id: str,
    audio_type: str
  ) -> str:
    """
    Get the object key for the audio file to process.

    track_id: Track ID to process
    audio_type: Type of audio to process
    """
    if audio_type in ["original", "normalized"]:
      return f"library/tracks/{track_id}/audio/{audio_type}.mp3"
    elif audio_type.startswith("speaker_"):
      return f"library/tracks/{track_id}/artifacts/diarization/{audio_type}.mp3"
    else:
      raise ValueError(f"Invalid audio type: {audio_type}")


  @task(task_display_name="📜 Parse Raw Response")
  def parse_raw_response(
    response: dict,
  ) -> Transcript:
    """
    Parse the raw response from the API and extract the transcript.
    
    response: Raw response from the Deepgram API
    """
    blocks = []
    first_channel = response["results"]["channels"][0]
    first_alternative = first_channel["alternatives"][0]["paragraphs"]
    paragraphs = first_alternative["paragraphs"]
    for paragraph in paragraphs:
      blocks.extend([
        TranscriptBlock(
          type="sentence",
          text=sentence["text"],
          start=float(sentence["start"]),
          end=float(sentence["end"]),
        ) for sentence in paragraph["sentences"]]
      )
      blocks.append(TranscriptBlock(type="paragraph"))

    return Transcript(version=1, blocks=blocks)


  @task(task_display_name="🏁 Complete")
  def complete(
    bucket_key_audio_file: str,
    bucket_key_raw_response: str,
    bucket_key_transcript: str,
  ):
    """
    Add links to the artifacts in the DAG run notes.

    bucket_key_audio_file: Object key for the audio file
    bucket_key_raw_response: Object key for the raw response
    bucket_key_transcript: Object key for the transcript
    """
    context: Context = get_current_context()
    dag_run = context['dag_run']

    set_dag_run_note.function(
      dag_run=dag_run,
      note=(
        f"### Links\n"
        f"| File         | Link                       |\n"
        f"| ------------ | -------------------------- |\n"
        f"| Audio File   | {bucket_key_audio_file}    |\n"
        f"| Raw Response | {bucket_key_raw_response}  |\n"
        f"| Transcript   | {bucket_key_transcript}    |\n"))


  # ---------------------------------------------------------------------------- #
  #                                      Flow                                    #
  # ---------------------------------------------------------------------------- #

  (
    bucket_key_audio_file :=
      get_audio_file_object_key(conf_track_id, conf_audio_type)
  ) >> (
    bucket_signed_url_audio_file :=
      bucket_sign_url(bucket_key_audio_file, "get")
  ) >> (
    transcribe_audio_file_response :=
      deepgram_transcribe_audio_file(
        bucket_signed_url_audio_file, conf_language)
  ) >> (
    transcript_generated := parse_raw_response(transcribe_audio_file_response)
  ) >> (
    bucket_upload_data
      .override(task_display_name="⬆️ Bucket: Upload Transcript")
      (conf_bucket_key_transcript, transcript_generated)
  ) >> (
    complete(
      bucket_key_audio_file,
      conf_bucket_key_raw_response,
      conf_bucket_key_transcript)
  )

  transcribe_audio_file_response >> (
    bucket_upload_data
      .override(task_display_name="⬆️ Bucket: Upload Raw Response")
      (conf_bucket_key_raw_response, transcribe_audio_file_response)
  )


transcript_transcribe_audio()
