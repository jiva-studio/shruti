from datetime import datetime, timedelta

from airflow.models import Param
from airflow.models import Variable
from airflow.decorators import dag, task
from airflow.utils.context import Context

from lectorium.shared import LANGUAGE_PARAMS, LANGUAGES_PARAMS_OPTIONAL

from lectorium.couchdb import couchdb_find_document
from lectorium.bucket import bucket_upload_data
from lectorium.tracks_inbox import TrackInbox
from lectorium.claude import claude_run_prompt
from lectorium.config.database import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LectoriumDatabaseCollections)


@dag(
  dag_display_name="📜 Track: Translate Metadata",
  description="Translates metadata for the given track in the given language.",
  start_date=datetime(2021, 1, 1),
  schedule=None,
  catchup=False,
  tags=["lectorium", "tracks"],
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
    "languages_translate_into": Param(
      default=[],
      description="Translate metadata into the given languages",
      title="🇷🇸 Translate Into",
      **LANGUAGES_PARAMS_OPTIONAL,
    ),
  },
)
def track_translate_metadata():
  """
  Translates metadata for the given track in the given language.

  #### Input Parameters:
  - `track_id`: Track ID to process
  - `language_translate_into`: Translate metadata into the given language

  #### Output:
  - `library/tracks/{track_id}/artifacts/metadata/titles.json`: Translated metadata
  """

  # ---------------------------------------------------------------------------- #
  #                                    Config                                    #
  # ---------------------------------------------------------------------------- #

  conf_track_id      = "{{ params.track_id }}"
  conf_language_into = "{{ params.languages_translate_into }}"
  conf_result_path   = "{{ 'library/tracks/' ~ params.track_id ~ '/artifacts/metadata/titles.json' }}"

  conf_database_connection_string = \
    Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

  conf_database_collections: LectoriumDatabaseCollections = \
    Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)


  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(
    task_display_name="🌎 Translate Title")
  def translate_title(
    document: TrackInbox,
    translate_into: list[str],
  ) -> dict:
    result = {}
    for language in translate_into:
      translated = claude_run_prompt.function(
        system_message="""
          You are a translator. Translate the text into the given language.
          Return only translation. No extra information.
          """,
        prompt=f"Translate the following into {language}:",
        chunk=document["title"]["normalized"],
      )
      result[language] = translated

    return result

  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  (
    track_document := couchdb_find_document.override(
      task_display_name="🗄️ CouchDB: Get Metadata",
    ) (
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["tracks_inbox"],
      filter={
        "track_id": conf_track_id,
      },
    )
  ) >> (
    translated_titles := translate_title(
      document=track_document,
      translate_into=conf_language_into)
  ) >> (
    bucket_upload_data.override(
      task_display_name="📤 Bucket: Upload Translated Metadata",
    ) (
      data=translated_titles,
      object_key=conf_result_path,
    )
  )


track_translate_metadata()
