import string
from sqids import Sqids

from datetime import datetime, timedelta

from airflow.models import Param
from airflow.models import Variable
from airflow.decorators import dag, task


from lectorium.couchdb import couchdb_get_document, couchdb_save_document
from lectorium.tracks import Track
from lectorium.config.database import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LectoriumDatabaseCollections)



@dag(
  dag_display_name="📜 Index: Generate",
  description="Generates search index for the given track.",
  start_date=datetime(2021, 1, 1),
  schedule=None,
  catchup=False,
  tags=["lectorium", "tracks", "index"],
  dagrun_timeout=timedelta(minutes=60*32),
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
  },
)
def index_generate():
  """
  Translates metadata for the given track in the given language.

  #### Input Parameters:
  - `track_id`: Track ID to process
  """

  # ---------------------------------------------------------------------------- #
  #                                    Config                                    #
  # ---------------------------------------------------------------------------- #

  conf_track_id = "{{ params.track_id }}"

  conf_database_connection_string = \
    Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

  conf_database_collections: LectoriumDatabaseCollections = \
    Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)

  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(
    task_display_name="🌎 Get Index Words")
  def get_words_to_index(
    document: Track,
  ) -> list[str]:
    result = set()
    for title in document["title"].values():
      clean_title = (
        title.translate(str.maketrans("", "", string.punctuation))
        .lower())
      
      for reference in document["references"]:
        clean_title += " " + " ".join(reference)

      if document["date"]:
        clean_title += " " + str(document["date"][0])

      for word in clean_title.split():
        result.add(word)

    return list(result)

  @task(
    task_display_name="📤 Update Index Document",
    map_index_template="{{ word }}")
  def update_index_document(
    word: str,
    track_id: str,
  ):
    sqids = Sqids(min_length=10)
    numerical_track_id = sqids.decode(track_id)[0]

    document = couchdb_get_document.function(
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["index"],
      document_id=word,
    )

    if document is None:
      document = {
        "_id": word,
        "tracks": [],
      }

    if track_id not in document["tracks"]:
      document["tracks"].append(numerical_track_id)

    couchdb_save_document.function(
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["index"],
      document=document)


  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  (
    track_document := couchdb_get_document.override(
      task_display_name="🗄️ CouchDB: Get Track",
    ) (
      document_id=conf_track_id,
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["tracks"],
    )
  ) >> (
    words := get_words_to_index(document=track_document)
  ) >> (
    update_index_document
      .partial(track_id=conf_track_id)
      .expand(word=words)
  )


index_generate()
