from datetime import datetime, timedelta
from cuid2 import cuid_wrapper
from typing import Callable

from airflow.decorators import dag, task
from airflow.models import Variable

from shruti.shared import run_dag
from shruti.bucket import bucket_move_file
from shruti.tracks_inbox import TrackInbox
from shruti.couchdb import couchdb_find_documents
from shruti.config.database import (
  SHRUTI_DATABASE_COLLECTIONS, SHRUTI_DATABASE_CONNECTION_STRING,
  ShrutiDatabaseCollections)


@dag(
  schedule="@hourly",
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["shruti", "tracks", "inbox"],
  dag_display_name="📥 Inbox: Start Processing",
  dagrun_timeout=timedelta(minutes=60*48),
  default_args={
    "owner": "Advaita Krishna das",
  },
  render_template_as_native_obj=True,
)
def inbox_start_processing():

  # ---------------------------------------------------------------------------- #
  #                                    Configs                                   #
  # ---------------------------------------------------------------------------- #
  
  conf_database_connection_string = \
    Variable.get(SHRUTI_DATABASE_CONNECTION_STRING)

  conf_database_collections: ShrutiDatabaseCollections = \
    Variable.get(SHRUTI_DATABASE_COLLECTIONS, deserialize_json=True)


  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #
  @task(
    task_display_name="📥 Get New Inbox Files")
  def get_ready_to_process_documents() -> list[TrackInbox]:
    return couchdb_find_documents.function(
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["tracks_inbox"],
      filter={"status": "pending"},
    )
  
  @task(
    task_display_name="📥 Move File to Library")
  def move_file_to_library(
    document: TrackInbox,
    **kwargs,
  ) -> TrackInbox:
    cuid_generator: Callable[[], str] = cuid_wrapper()
    track_id = cuid_generator()
    bucket_move_file.function(
      source_key=document["path"],
      destination_key=f"library/tracks/{track_id}/audio/original.mp3",
    )

    run_dag.function(
      dag_id="track_process",
      track_id=track_id,
      conf={
        "track_id": track_id,
        "languages_in_audio_file": ["en"],
        "languages_to_translate_into": [],
        "speakers_count": 1,
      }, 
      task_instance=kwargs["ti"],
    )
  
  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  (
    # TODO limit documents
    ready_to_process_documents := get_ready_to_process_documents()
  ) >> (
    move_file_to_library.expand(document=ready_to_process_documents)
  )

inbox_start_processing()
