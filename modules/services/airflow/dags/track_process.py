from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param
from airflow.exceptions import AirflowSkipException

from lectorium.shared import run_dag, wait_dag_run

import lectorium as lectorium


@dag(
  schedule=None,
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "tracks"],
  dag_display_name="▶️ Track: Process",
  dagrun_timeout=timedelta(minutes=60*48),
  default_args={
    "owner": "Advaita Krishna das",
  },
  render_template_as_native_obj=True,
  params={
    "track_id": Param(
      default="",
      description="Track ID to process",
      type="string",
      title="Track ID",
    ),
    "languages_in_audio_file": Param(
      default=["en"],
      description="Languages present in the audio file. First language will be used for translating transcripts into other languages",
      title="Languages",
      **lectorium.shared.LANGUAGES_PARAMS,
    ),
    "languages_to_translate_into": Param(
      default=[],
      description="Languages to translate transcript into",
      title="Translate Into",
      **lectorium.shared.LANGUAGES_PARAMS_OPTIONAL,
    ),
    "speakers_count": Param(
      default=2,
      description="Number of speakers in the audio file",
      type="integer",
      title="👥 Speakers",
    ),
    "chunk_size": Param(
      default=150,
      description="Number of blocks in a chunk",
      type="integer",
      title="Chunk Size",
    ),
  },
)
def track_process():
  conf_track_id                    = "{{ params.track_id | string }}"
  conf_languages_in_audio_file     = "{{ params.languages_in_audio_file }}"
  conf_languages_to_translate_into = "{{ params.languages_to_translate_into }}"
  conf_speakers_count              = "{{ params.speakers_count | int }}"
  conf_audio_type                  = "original"
  
  @task(
    task_display_name="🗂️ Track: Translate Metadata")
  def run_track_translate_metadata(
    track_id: str,
    languages_to_translate_into: list[str],
    **kwargs,
  ) -> str:
    """
    Translate metadata for the given track in the given language.
    """
    if not languages_to_translate_into:
      raise AirflowSkipException("No translation requested.")
    
    return run_dag.function(
      dag_id="track_translate_metadata",
      track_id=track_id,
      conf={
        "track_id": track_id,
        "languages_translate_into": languages_to_translate_into
      },
      task_instance=kwargs["ti"],
    )

  @task(
    task_display_name="🗣️ Audio: Speaker Diarization")
  def run_audio_speaker_diarization(
    track_id: str,
    audio_type: str,
    speakers_count: int,
    **kwargs,
  ) -> str:
    """
    Run speaker diarization on the audio file to identify speakers if required
    """
    if (speakers_count <= 1):
      raise AirflowSkipException("Diarization is not required for single speaker audio files")
  
    return run_dag.function(
      dag_id="audio_speaker_diarization",
      track_id=track_id,
      conf={
        "track_id": track_id,
        "audio_type": audio_type,
        "speakers_count": speakers_count
      }, 
      task_instance=kwargs["ti"],
    )
  
  @task(
    task_display_name="📜 Transcript: Extract",
    trigger_rule="none_failed")
  def run_transcript_extract(
    track_id: str,
    audio_type: str,
    languages_in_audio_file: list[str],
    languages_to_translate_into: list[str],
    **kwargs,
  ) -> str:
    """
    Extract transcript from the audio file
    """
    return run_dag.function(
      dag_id="transcript_extract",
      track_id=track_id,
      conf={
        "track_id": track_id,
        "audio_type": audio_type,
        "languages_in_audio_file": languages_in_audio_file,
        "languages_to_translate_into": languages_to_translate_into
      },
      task_instance=kwargs["ti"],
    )

  @task(
    task_display_name="💾 Track: Save",
    trigger_rule="none_failed")
  def run_track_save(
    track_id: str,
    **kwargs,
  ) -> str:
    """
    Save the processed track to the database
    """
    return run_dag.function(
      dag_id="track_save",
      track_id=track_id,
      conf={
        "track_id": track_id,
      },
      task_instance=kwargs["ti"],
    )

  @task(
    task_display_name="🗄️ Index: Update")
  def run_index_generate(
    track_id: str,
    **kwargs,
  ) -> str:
    """
    Update the index for the given track
    """
    return run_dag.function(
      dag_id="index_generate",
      track_id=track_id,
      conf={
        "track_id": track_id,
      },
      task_instance=kwargs["ti"],
    )

  # ---------------------------------------------------------------------------- #
  #                                       Flow                                   #
  # ---------------------------------------------------------------------------- #

  (
    track_translate_metadata_run_id := run_track_translate_metadata(
      track_id=conf_track_id,
      languages_to_translate_into=conf_languages_to_translate_into,
    )
  ) >> (
    track_translate_metadata_run := wait_dag_run(
      dag_id="track_translate_metadata",
      dag_run_id=track_translate_metadata_run_id)
  )

  (
    audio_diarization_dag_run_id := run_audio_speaker_diarization(
      track_id=conf_track_id,
      audio_type=conf_audio_type,
      speakers_count=conf_speakers_count,
    )
  ) >> (
    wait_dag_run(
      dag_id="audio_speaker_diarization",
      dag_run_id=audio_diarization_dag_run_id)
  ) >> (
    transcript_extract_dag_run_id := run_transcript_extract(
      track_id=conf_track_id,
      audio_type=conf_audio_type,
      languages_in_audio_file=conf_languages_in_audio_file,
      languages_to_translate_into=conf_languages_to_translate_into,
    )
  ) >> (
    wait_dag_run(
      dag_id="transcript_extract",
      dag_run_id=transcript_extract_dag_run_id)
  ) >> (
    track_save_dag_run_id := run_track_save(
      track_id=conf_track_id,
    )
  ) >> (
    wait_dag_run(
      dag_id="track_save",
      dag_run_id=track_save_dag_run_id)
  ) >> (
    track_index_generate_dag_run_id := run_index_generate(
      track_id=conf_track_id,
    )
  ) >> (
    wait_dag_run(
      dag_id="index_generate",
      dag_run_id=track_index_generate_dag_run_id)
  )

  track_translate_metadata_run >> track_save_dag_run_id

  
track_process()
