import hashlib
import redis
from sqids import Sqids

from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Variable
from airflow.models import Param
from airflow.exceptions import AirflowSkipException

from lectorium.couchdb import couchdb_get_document
from lectorium.tracks_inbox import TrackInbox
from lectorium.couchdb import couchdb_save_document
from lectorium.config import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LECTROIUM_TRACK_INBOX_LAST_SCAN, LECTROIUM_TRACK_INBOX_PROCESSING_CHUNK_SIZE,
  LectoriumDatabaseCollections)
from lectorium.bucket import bucket_list_files, BucketObjectInfo


@dag(
  schedule="@daily",
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "tracks", "inbox"],
  dag_display_name="📥 Inbox: Scan for New Tracks",
  dagrun_timeout=timedelta(minutes=15),
  max_active_runs=1,
  render_template_as_native_obj=True,
  default_args={
    "owner": "Advaita Krishna das",
  },
  params={
    "path": Param(
      default="inbox",
      description="Folder in the bucket to scan",
      type="string",
      title="📁 Folder",
    ),
  },
)
def inbox_scan_for_new_tracks():
  """
  Scans the inbox for new tracks and saves them in the database.

  #### Input Parameters:
  - `path`: Folder in the bucket to scan for new tracks.

  #### Configs:
  - `lectorium::inbox::last-scan-date`: Last scan date for the inbox.
  - `lectorium::inbox::processing-chunk-size`: Number of files to process at once.

  #### Services:
  - `CouchDB`: Database to save the tracks.
  """

  # ---------------------------------------------------------------------------- #
  #                                    Configs                                   #
  # ---------------------------------------------------------------------------- #
  
  conf_path_to_scan = "{{ params.path | string }}"

  conf_database_connection_string = \
    Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

  conf_database_collections: LectoriumDatabaseCollections = \
    Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)

  conf_last_inbox_scan_date = Variable.get(
    LECTROIUM_TRACK_INBOX_LAST_SCAN,
    default_var=0)

  conf_processing_chunk_size = Variable.get(
    LECTROIUM_TRACK_INBOX_PROCESSING_CHUNK_SIZE,
    default_var=32)


  # ---------------------------------------------------------------------------- #
  #                                    Helpers                                   #
  # ---------------------------------------------------------------------------- #

  def get_track_inbox_id(
    path: str,
  ) -> str:
    """
    Generate a unique Id for the track based on the path
    """
    sha1_hash = hashlib.sha1()
    sha1_hash.update(path.encode('utf-8'))
    return sha1_hash.hexdigest()

  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(
    task_display_name="🔎 Get Processing Chunk")
  def get_processing_chunk(
    bucket_objects: list[BucketObjectInfo],
    last_inbox_scan_date: int,
    chunk_size: int,
  ) -> list[BucketObjectInfo]:
    """
    Get the chunk of files to process.
    """
    # sort the files by last modified date and key
    # and get the chunk of files to process
    # filter the files that are modified after the last scan date
    chunk = sorted(
      [item for item in bucket_objects if item["last_modified"] > last_inbox_scan_date],
      key=lambda x: (x["last_modified"], x["key"])
    )[:chunk_size]

    # set the last scan date to the last modified date of the last file
    Variable.set(
      "lectorium::inbox::last-scan-date",
      chunk[-1]["last_modified"] if chunk else last_inbox_scan_date)

    # returns list of files to process
    return chunk


  @task(
    task_display_name="🆕 Get Unprocessed")
  def get_unprocessed(
    bucket_objects: list[BucketObjectInfo],
  ) -> list[BucketObjectInfo]:
    """
    Get the unprocessed files from the inbox. Unprocessed files are
    files that are not already in the database in the inbox collection.
    """
    if not bucket_objects:
      raise AirflowSkipException("Nothing to process")

    result = []
    for item in bucket_objects:
      # check if the document already exists in the database
      # if it does, skip it
      document = couchdb_get_document.function(
        conf_database_connection_string,
        conf_database_collections["tracks_inbox"],
        get_track_inbox_id(item["key"]))
      if document is not None:
        continue
      result.append(item)

    # return the list of files that are not in the database
    # and need to be processed
    return result 

  @task(
    task_display_name="📥 Save Inbox")
  def save_inbox(
    bucket_objects: list[BucketObjectInfo],
  ) -> None:
    """
    Saves information about files in the inbox in the database.
    """
    if not bucket_objects:
      raise AirflowSkipException("Nothing to process")

    # TODO: extract to config
    sequence_name = "lectorium::track-id-sequence"
    redis_client = redis.Redis(host="redis", port=6379)
  
    for inbox in bucket_objects:
      # get unique id for the track
      try:
        next_id = redis_client.incr(sequence_name)
      except redis.RedisError as e:
        raise Exception(f"Failed to generate ID from Redis: {str(e)}")

      # save the document in the database if it doesn't exist
      # with the status set to "new" to indicate that it needs
      # to be processed further
      sqids = Sqids(min_length=10)
      couchdb_save_document.function(
        conf_database_connection_string,
        conf_database_collections["tracks_inbox"],
        TrackInbox(
          _id=get_track_inbox_id(inbox["key"]),
          track_id=sqids.encode([next_id]),
          path=inbox["key"],
          status="new",
        ),
      )

  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  (
    inbox_objects := bucket_list_files
      .override(task_display_name="🔎 Scan Inbox")(conf_path_to_scan)
  ) >> (
    processing_chunk := get_processing_chunk(
      bucket_objects=inbox_objects,
      last_inbox_scan_date=conf_last_inbox_scan_date,
      chunk_size=conf_processing_chunk_size)
  ) >> (
    unprocessed_objects := get_unprocessed(
      bucket_objects=processing_chunk)
  ) >> (
    save_inbox(bucket_objects=unprocessed_objects)
  )

inbox_scan_for_new_tracks()
