from datetime import datetime, timedelta
from typing import TypedDict

from airflow.decorators import dag, task
from airflow.models import Param, Variable

from lectorium.couchdb import couchdb_save_document
from lectorium.config.database import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LectoriumDatabaseCollections)
from lectorium.bucket import bucket_download_json_data, bucket_list_files


@dag(
  schedule=None,
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "tracks"],
  dag_display_name="▶️ Track: Save",
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
  },
)
def track_save():
  """
  Saves track and transcripts in the database.
  """

  # ---------------------------------------------------------------------------- #
  #                                    Helpers                                   #
  # ---------------------------------------------------------------------------- #

  class transcript_info(TypedDict):
    language: str
    path: str
    kind: str

  # ---------------------------------------------------------------------------- #
  #                                    Config                                    #
  # ---------------------------------------------------------------------------- #

  conf_track_id     = "{{ params.track_id | string }}"
  conf_track_folder = "{{ 'library/tracks/' ~ params.track_id }}"
  
  conf_database_connection_string = \
    Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

  conf_database_collections: LectoriumDatabaseCollections = \
    Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)

  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(
    task_display_name="☑️ Get Save Transcript Tasks")
  def get_transcripts_to_save(
    file_paths: list[str],
  ) -> list[transcript_info]: 
    is_transcript = lambda path: path.startswith("/artifacts/transcripts")
    get_language  = lambda path: path.split("/")[3]
    get_kind      = lambda path: path.split("/")[4].split(".")[0]
    
    # filter out only translated and proofread transcripts
    transcript_file_paths = [
      file_path for file_path in file_paths 
      if is_transcript(file_path) and 
         get_kind(file_path) in ["translated", "proofread"]
    ]

    # return transcript info
    return [
      transcript_info(
        language=get_language(path),
        kind=get_kind(path),
        path=path
      ) for path in transcript_file_paths 
    ]

  @task(
    task_display_name="💾 Save Transcript")
  def save_transcript_in_database(
    track_id: str,
    transcript_info: transcript_info,
   ):
    document = bucket_download_json_data.function(
      object_key=f"library/tracks/{track_id}{transcript_info['path']}") 
   
    couchdb_save_document.function(
      conf_database_connection_string,
      conf_database_collections["transcripts"],
      document,
      f"{track_id}::{transcript_info['language']}"
    )

  @task(
    task_display_name="📂 Save Track")
  def save_track_in_database(
    track_id: str,
    transcripts_info: transcript_info,
  ):
    document = {
      "_id": track_id,
      "languages": [{
        "language": transcript_info["language"],
        "source": "transcript",
      } for transcript_info in transcripts_info]
    }
    return document

  # ---------------------------------------------------------------------------- #
  #                                       Flow                                   #
  # ---------------------------------------------------------------------------- #

  (
    files_in_bucket := bucket_list_files(conf_track_folder)
  ) >> (
    transcripts_info := get_transcripts_to_save(files_in_bucket)
  ) >> [
    (
      save_transcript_in_database
        .partial(track_id=conf_track_id)
        .expand(transcript_info=transcripts_info)
    ), (
      save_track_in_database(
        track_id=conf_track_id, 
        transcripts_info=transcripts_info)
    )
  ]


track_save()
