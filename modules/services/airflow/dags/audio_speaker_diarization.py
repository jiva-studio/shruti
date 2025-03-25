from collections import namedtuple
from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from lectorium.audio import (
  audio_isolate_segments, audio_create_from_segments, audio_transcribe)
from lectorium.text import text_detect_language
from lectorium.bucket import (
  bucket_upload_data, bucket_download_file, bucket_upload_file,
  bucket_upload_file)
from lectorium.pyannoteai import (
  pyannoteai_job_sensor, pyannoteai_submit_job,
  pyannoteai_get_results, pyannoteai_get_segments)
from lectorium.shared import set_dag_run_note


@dag(
  schedule=None,
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "audio"],
  dag_display_name="🗣️ Audio: Speaker Diarization",
  dagrun_timeout=timedelta(minutes=60),
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
      default="normalized",
      description="Type of audio to process",
      title="🎙️ Audio Type",
      type="string",
      enum=["original", "normalized"],
      values_display={
        "original": "📼 Original",
        "normalized": "💿 Normalized",
      },
    ),
    "speakers_count": Param(
      default=2,
      description="Number of speakers in the audio file",
      type="integer",
      title="👥 Speakers",
    ),
  },
)
def audio_speaker_diarization():
  """
  Perform speaker diarization on the given track and isolate the speakers.

  #### Input Parameters:
  - `track_id`: Track ID to process
  - `audio_type`: Type of audio to process: `original` or `normalized`
  - `speakers_count`: Number of speakers in the audio file

  ### Input Files:
  - `library/tracks/{track_id}/audio/{audio_type}.mp3`: Audio file to process

  #### Outputs Files:
  - `library/tracks/{track_id}/artifacts/diarization/raw/pyannoteai_response.json`: PyAnnoteAI response
  - `library/tracks/{track_id}/artifacts/diarization/diarization.json`: Speaker diarization report
  - `library/tracks/{track_id}/artifacts/diarization/speaker_{speaker_id}.mp3`: Isolated audio files for each speaker

  #### External Services:
  - PyAnnoteAI: Speaker diarization
  - Hugging Face: Language detection from audio excerpts

  #### Diarization Report (diarization.json):
  ```json
  {
    "speakers": [
      {
        "speaker_id": 1,
        "language": "en",
        "segments": [[0, 10], [20, 30]],
        "path": "artifacts/tracks/{track_id}/audio/speaker_1.mp3"
      },
      {
        "speaker_id": 2,
        "language": "es",
        "segments": [[10, 20], [30, 40]],
        "path": "artifacts/tracks/{track_id}/audio/speaker_2.mp3"
      }
    ]
  }
  ```
  """

  # ---------------------------------------------------------------------------- #
  #                                    Helpers                                   #
  # ---------------------------------------------------------------------------- #

  speaker_diarization_data = namedtuple(
    "speaker_diarization_data",
    ["speaker_id", "language", "path", "segments"])
  
  speaker_diarization_note = namedtuple(
    "speaker_diarization_data",
    ["speaker_id", "language", "path", "excerpt"])

  # ---------------------------------------------------------------------------- #
  #                                    Config                                    #
  # ---------------------------------------------------------------------------- #

  conf_bucket_key_audio_file = \
    "{{ 'library/tracks/' ~ params.track_id ~ '/audio/' ~ params.audio_type ~ '.mp3' }}"

  conf_bucket_key_output_folder = \
    "{{ 'library/tracks/' ~ params.track_id ~ '/artifacts/diarization' }}"

  conf_bucket_key_diarization_response = \
    "{{ 'library/tracks/' ~ params.track_id ~ '/artifacts/diarization/raw/pyannoteai_response.json' }}"

  conf_bucket_key_diarization_report = \
    "{{ 'library/tracks/' ~ params.track_id ~ '/artifacts/diarization/diarization.json' }}"

  conf_speakers_count = \
    "{{ params.speakers_count | int }}"

  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(task_display_name="🗣️ Get Speaker Ids")
  def get_speaker_ids(count: int):
    return [i+1 for i in range(count)]

  @task(
    task_display_name="⬆️ Upload Isolated Files",
    map_index_template="{{ 'Speaker ' ~ local_file_path[1] }}")
  def upload_isolated_files(
    local_file_path: tuple[str, int],
    bucket_output_folder_key: str,
  ) -> str:
    """
    Upload isolated audio files to the bucket. Returns the object key.
    
    local_file_path: Tuple of local file path and speaker ID
    bucket_output_folder_key: Output folder key in the bucket
    """
    local_path, speaker_id = local_file_path
    object_key = f"{bucket_output_folder_key}/speaker_{speaker_id}.mp3"
    bucket_upload_file.function(local_path, object_key)
    return object_key

  @task(task_display_name="📄 Generate Report")
  def generate_diarization_report(
    data: list[speaker_diarization_data],
  ) -> dict:
    """
    Generate diarization report from the speaker diarization data which
    includes speaker ID, language, path, and segments.

    data: List diariazation data for each speaker
    """
    return {
      "speakers": [{
        "speaker_id": speaker_id,
        "language": language,
        "segments": segments,
        "path": path,
      } for (speaker_id, language, path, segments) in data]
    }

  @task(task_display_name="📝 Add Note")
  def add_note(
    data: list[speaker_diarization_note]
  ):
    """
    Add a note to the current DAG run with the speaker diarization data.
    
    data: List of speaker diarization data
    """
    note = ""
    for (speaker_id, language, path, excerpt) in data:
      note += f"## Speaker {speaker_id}\n\n"
      note += f"> ...{excerpt[:128]}...\n\n\n\n"
      note += f"**Language**: {language}\n\n"
      note += f"**Path**: {path}\n\n\n\n"

    context: Context = get_current_context()
    dag_run = context['dag_run']
    set_dag_run_note.function(dag_run=dag_run, note=note)

  @task(task_display_name="🧹 Cleanup")
  def cleanup(
    original_file,
    isolated_files: list[str],
    isolated_files_excepts: list[str],
  ) -> None:
    import os
    os.remove(original_file)
    for file in isolated_files:
      os.remove(file)
    for file in isolated_files_excepts:
      os.remove(file)

  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  bucket_upload_pynnoteai_response = bucket_upload_data.override(
    task_display_name="⬆️ Bucket: Upload PyAnnoteAI response")
  bucket_upload_diarization_report = bucket_upload_data.override(
    task_display_name="⬆️ Bucket: Upload Diarization Report")
  download_track = bucket_download_file.override(
    task_display_name="⬇️ Bucket: Download Track")
  audio_transcribe_exceprts = audio_transcribe.override(
    task_display_name="📝 Transcribe Audio Excepts")

  # --------------------- Submit and Upload PyAnnoteAI Job --------------------- #

  (
    diarization_job_id := pyannoteai_submit_job(
      bucket_object_key=conf_bucket_key_audio_file,
      speaker_count=conf_speakers_count)
  ) >> (
    pyannoteai_job_sensor(job_id=diarization_job_id)
  ) >> (
    diarization_result_raw := pyannoteai_get_results(job_id=diarization_job_id)
  ) >> (
    bucket_upload_pynnoteai_response(
      object_key=conf_bucket_key_diarization_response,
      data=diarization_result_raw)
  )

  # --------------- Get Speaker Segments from PyAnnoteAI Response -------------- #

  (
    speakers_ids := get_speaker_ids(count=conf_speakers_count)
  ) >> (
    speakers_segments := pyannoteai_get_segments
      .partial(data=diarization_result_raw)
      .expand(speaker_id=speakers_ids)
  )

  # ------------------------- Isolate and Upload Files ------------------------- #

  (
    file_original := download_track(conf_bucket_key_audio_file)
  ) >> (
    files_isolated_local := audio_isolate_segments
      .partial(file=file_original)
      .expand(segments=speakers_segments)
  ) >> (
    files_isolated_uploaded := upload_isolated_files
      .partial(bucket_output_folder_key=conf_bucket_key_output_folder)
      .expand(local_file_path=files_isolated_local.zip(speakers_ids))
  )

  # ------------------ Detect Language from Isolated Excerpts ------------------ #

  (
    files_isolated_excepts := audio_create_from_segments
      .partial(file=file_original)
      .expand(segments=speakers_segments)
  ) >> (
    excerpt_texts := audio_transcribe_exceprts.expand(file=files_isolated_excepts)
  ) >> (
    languages := text_detect_language.expand(text=excerpt_texts)
  )

  # ------------------------ Generate and Upload Report ------------------------ #

  (
    report_generated := generate_diarization_report(
      speakers_ids.zip(languages, files_isolated_uploaded, speakers_segments))
  ) >> (
    uploaded_diarization_report :=
    bucket_upload_diarization_report(
      conf_bucket_key_diarization_report, report_generated)
  ) >> (
    add_note(speakers_ids.zip(languages, files_isolated_uploaded, excerpt_texts))
  )

  # ---------------------------------- Cleanup --------------------------------- #

  uploaded_diarization_report >> (
    cleanup(file_original, files_isolated_local, files_isolated_excepts)
  )

audio_speaker_diarization()
