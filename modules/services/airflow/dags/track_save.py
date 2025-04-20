from pathlib import Path
from datetime import datetime, timedelta
from typing import TypedDict

from airflow.decorators import dag, task
from airflow.models import Param, Variable

from lectorium.couchdb import couchdb_save_document
from lectorium.config.database import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LectoriumDatabaseCollections)
from lectorium.bucket import (
  bucket_download_json_data, bucket_list_files, get_audio_duration,
  BucketObjectInfo)


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

  class audio_file_info(TypedDict):
    path: str
    type: str
    size: int
    duration: int

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
    track_id: str,
    bucket_objects: list[BucketObjectInfo],
  ) -> list[transcript_info]:
    result: list[transcript_info] = []
    transcript_prefix = f"library/tracks/{track_id}/artifacts/transcripts"

    for bucket_object in bucket_objects:
      if not bucket_object["key"].startswith(transcript_prefix):
        continue

      path     = bucket_object["key"].removeprefix(transcript_prefix)
      language = path.split("/")[1]
      kind     = Path(path).stem 
      print(path)

      if kind not in ["translated", "proofread"]:
        continue

      result.append(
        transcript_info(
          language=language,
          kind=kind,
          path=bucket_object["key"]
        ) 
      )
    return result

  @task(
    task_display_name="☑️ Get Audio Files")
  def get_audio_files(
    track_id: str,
    bucket_objects: list[BucketObjectInfo],
  ) -> list[transcript_info]: 
    result: list[transcript_info] = []
    audio_prefix = f"library/tracks/{track_id}/audio"

    for bucket_object in bucket_objects:
      if not bucket_object["key"].startswith(audio_prefix):
        continue

      path  = bucket_object["key"].removeprefix(audio_prefix)
      type  = Path(path).stem 

      if type not in ["original", "normalized"]:
        continue

      result.append(
        audio_file_info(
          type=type,
          path=bucket_object["key"],
          size=bucket_object["size"],
          duration=int(get_audio_duration.function(bucket_object['key'])),
        ) 
      )
    return result


  @task(
    task_display_name="💾 Save Transcript")
  def save_transcript_in_database(
    track_id: str,
    transcript_info: transcript_info,
   ):
    raw_document = bucket_download_json_data.function(
      object_key=transcript_info['path']) 
   
    transcript_document = {
      "@type": "transcript",
      "version": 1,
      "blocks": raw_document["blocks"],
    }

    couchdb_save_document.function(
      conf_database_connection_string,
      conf_database_collections["transcripts"],
      transcript_document,
      f"{track_id}::transcript::{transcript_info['language']}"
    )

  @task(
    task_display_name="📂 Save Track")
  def save_track_in_database(
    track_id: str,
    transcripts_info: list[transcript_info],
    audio_files_info: list[audio_file_info],
  ):
    track_document = {
      "_id": track_id + "::track",
      "@type": "track",
      "version": 1,
      "duration": 0,
      "audio": {
        afi["type"]: {
          "path": f"library/tracks/{track_id}{afi['path']}",
          "file_size": afi["size"],
          "duration": afi["duration"],
        } for afi in audio_files_info
      },
      "languages": [
        {
          "language": transcript_info["language"],
          "source": "transcript",
          "type": "generated",
        } for transcript_info in transcripts_info
      ] + [
        # TODO get info about original language from track inbox
      ]
    }

    couchdb_save_document.function(
      conf_database_connection_string,
      conf_database_collections["transcripts"],
      track_document,
    )

  # ---------------------------------------------------------------------------- #
  #                                       Flow                                   #
  # ---------------------------------------------------------------------------- #

  (
    files_in_bucket := bucket_list_files(conf_track_folder)
  ) >> [
    ( transcripts_info := get_transcripts_to_save(conf_track_id, files_in_bucket) ),
    ( audio_files_info := get_audio_files(conf_track_id, files_in_bucket) )
  ] 
  
  (
    save_transcript_in_database
      .partial(track_id=conf_track_id)
      .expand(transcript_info=transcripts_info)
  ), (
    save_track_in_database(
      track_id=conf_track_id, 
      transcripts_info=transcripts_info,
      audio_files_info=audio_files_info)
  )

track_save()
