from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Variable

from lectorium.shared import run_dag
from lectorium.bucket import bucket_move_file
from lectorium.tracks_inbox import TrackInbox
from lectorium.couchdb import couchdb_save_document, couchdb_find_documents
from lectorium.config.database import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LectoriumDatabaseCollections)


@dag(
  schedule="@hourly",
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "tracks", "inbox"],
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
    Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

  conf_database_collections: LectoriumDatabaseCollections = \
    Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)


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
    task_display_name="📥 Move File to Library",
    map_index_template="{{ document['track_id'] }}")
  def move_file_to_library(
    document: TrackInbox,
    **kwargs,
  ) -> TrackInbox:
    track_id = document["track_id"]
    bucket_move_file.function(
      source_key=document["path"],
      destination_key=f"library/tracks/{track_id}/audio/original.mp3",
    )

    run_dag.function(
      dag_id="track_process",
      track_id=track_id,
      conf={
        "track_id": track_id,
        "languages_in_audio_file": document["languagesExtract"],
        "languages_to_translate_into": document["languagesTranslateInto"],
        "speakers_count": len(document["languagesExtract"]),
      }, 
      task_instance=kwargs["ti"],
    )

  @task(
    task_display_name="📥 Mark Document as Processing")
  def mark_document_as_processing(
    document: TrackInbox,
  ) -> TrackInbox:
    document["status"] = "processing"
    couchdb_save_document.function(
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["tracks_inbox"],
      document=document,
    )
  
  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  (
    # TODO limit documents
    ready_to_process_documents := get_ready_to_process_documents()
  ) >> (
    move_file_to_library.expand(document=ready_to_process_documents)
  ) >> (
    mark_document_as_processing
      .expand(document=ready_to_process_documents)
  )

inbox_start_processing()
