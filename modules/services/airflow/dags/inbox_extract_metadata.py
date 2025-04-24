from collections import namedtuple
from typing import TypedDict
import jellyfish
from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Variable

from lectorium.tracks_inbox import TrackInbox, NormalizedValue
from lectorium.couchdb import couchdb_save_document, couchdb_find_documents
from lectorium.claude import claude_run_prompt
from lectorium.config import (
  LECTORIUM_DATABASE_COLLECTIONS, LECTORIUM_DATABASE_CONNECTION_STRING,
  LECTROIUM_TRACK_INBOX_PROCESSING_CHUNK_SIZE, EXTRACT_METADATA_PROMPT_PREFIX,
  LectoriumDatabaseCollections)


@dag(
  schedule="@daily",
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "tracks", "inbox"],
  dag_display_name="📥 Inbox: Extract Metadata",
  dagrun_timeout=timedelta(minutes=60*48),
  default_args={
    "owner": "Advaita Krishna das",
  },
  render_template_as_native_obj=True,
)
def inbox_extract_metadata():
  """
  Extracts and saves metadata for inbox tracs in _new_ status. Updates status
  of inbox track to verification.

  #### Services:
  - `CouchDB`: Database to save the tracks.
  - `Claude`: Extract metadata from the file name.
  """

  # ---------------------------------------------------------------------------- #
  #                                    Configs                                   #
  # ---------------------------------------------------------------------------- #
  
  conf_database_connection_string = \
    Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

  conf_database_collections: LectoriumDatabaseCollections = \
    Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)

  conf_processing_chunk_size = Variable.get(
    LECTROIUM_TRACK_INBOX_PROCESSING_CHUNK_SIZE,
    default_var=32)

  # ---------------------------------------------------------------------------- #
  #                                    Helpers                                   #
  # ---------------------------------------------------------------------------- #

  class file_meta_info(TypedDict):
    author: str
    title: str
    date: str
    location: str
    reference: str
    
  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(
    task_display_name="✂️ Get Processing Chunk")
  def get_processing_chunk(
    documents: list[TrackInbox],
    chunk_size: int
  ) -> list[TrackInbox]:
    """
    Get the processing chunk of documents.
    """
    return sorted(documents, key=lambda doc: doc["path"])[:chunk_size]


  @task(
    task_display_name="📥 Get Prompt")
  def get_prompt() -> str:
    """
    Get the prompt to extract metadata.
    """
    return Variable.get(EXTRACT_METADATA_PROMPT_PREFIX + "en")


  @task(
    task_display_name="📥 Parse Response")
  def parse_response(response: str) -> file_meta_info:
    """
    Split the response from Claude into a list of values.
    """
    tokens = response.split("|")
    return file_meta_info(
      author    = tokens[0] if len(tokens) > 0 else "",
      title     = tokens[1] if len(tokens) > 1 else "", 
      date      = tokens[2] if len(tokens) > 2 else "", 
      location  = tokens[3] if len(tokens) > 3 else "", 
      reference = tokens[4] if len(tokens) > 4 else "")


  @task(
    task_display_name="🌟 Enrich Inbox Track document")
  def enrich_inbox_document(
    document_and_normalized_values
  ) -> TrackInbox:
    """
    Enriches the inbox document with the extracted metadata.
    """
    document, normalized_author, normalized_location, normalized_title, normalized_date, normalized_reference = document_and_normalized_values
    document["status"]     = "verification"
    document["date"]       = normalized_date
    document["references"] = normalized_reference
    document["title"]      = normalized_title
    document["author"]     = normalized_author
    document["location"]   = normalized_location
    return document

  # ---------------------------------------------------------------------------- #
  #                                 Normlization                                 #
  # ---------------------------------------------------------------------------- #

  @task(
    task_display_name="📆 Normalize Date")
  def normalize_date(value: str) -> NormalizedValue:
    """
    Normalizes the date from the file name.
    """
    try:
      date_normalized = datetime.strptime(value.strip(), "%Y%m%d").date()
      return NormalizedValue(
        extracted=value,
        normalized=[
          date_normalized.year,
          date_normalized.month,
          date_normalized.day,
        ])
    except ValueError:
      print("Date is incorrect format: ", value)
      return NormalizedValue(
        extracted=value, 
        normalized=None)
   

  @task(
    task_display_name="📜 Normalize Reference")
  def normalize_reference(
    value: str,
    dictionary: list[dict]
  ) -> NormalizedValue:
    """
    Normalizes the reference from "BG 1.2.3" to "['bg', 1, 2, 3]".
    """
    reference_prefix = "reference::"

    try:
      references       = [d for d in dictionary if d["_id"].startswith(reference_prefix)]
      best_match_score = 0
      best_match_id    = None

      extracted_last_space_loc = value.rfind(" ")
      extracted_source         = value[:extracted_last_space_loc] if extracted_last_space_loc != 1 else value
      extracted_source_loc     = [
        (int(number.strip()) if number.strip().isdigit() else number.strip()) for number in
        (value[extracted_last_space_loc:] if extracted_last_space_loc != 1 else value).split(".")
      ]

      names = {
        item['_id']: list(item["shortName"].values())
        for item in references
      } # TODO get name for fullName also
      
      for entity_id, names in names.items():
        for name in names:
          score = jellyfish.jaro_winkler_similarity(extracted_source, name)
          if score > best_match_score:
            best_match_score = score
            best_match_id = entity_id

      return NormalizedValue(
        extracted=value,
        normalized=[
          best_match_id.removeprefix(reference_prefix)] + 
          extracted_source_loc if best_match_id else None)
    except Exception as e:
      print(f"Error {value}: ", e)
      return NormalizedValue(
        extracted=value, 
        normalized=None)


  @task(
    task_display_name="📝 Normalize Title")
  def normalize_title(value: str) -> NormalizedValue:
    """
    Normalizes the title from the file name.
    """
    return NormalizedValue(
      extracted=value,
      normalized=value.strip())


  @task(
    task_display_name="📥 Normalize Metadata")
  def normalize_field(
    value: str,
    field: str,
    dictionary: list[dict]
  ) -> TrackInbox:
    field_prefix = f"{field}::"
    try:
      entities         = [d for d in dictionary if d["_id"].startswith(field_prefix)]
      best_match_score = 0
      best_match_id    = None
      
      names = {
        item['_id']: list(item["fullName"].values())
        for item in entities
      }
      
      for entity_id, names in names.items():
        for name in names:
          score = jellyfish.jaro_winkler_similarity(value, name)
          print(f">> {value} ≈ {name} -> {score}")
          if score > best_match_score:
            best_match_score = score
            best_match_id = entity_id

      return NormalizedValue(
        extracted=value,
        normalized=best_match_id.removeprefix(field_prefix) if best_match_id else None)
    except Exception as e:
      print(f"Error {field}: ", e)
      return NormalizedValue(
        extracted=value, 
        normalized=None)

  # ---------------------------------------------------------------------------- #
  #                                     Flow                                     #
  # ---------------------------------------------------------------------------- #

  (
    dictionaly := couchdb_find_documents.override(
      task_display_name="📥 CouchDb: Load Dictionary"
    )(
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["dictionary"],
      filter={}
    )
  )

  (
    inbox_documents := couchdb_find_documents.override(
      task_display_name="📥 CouchDB: Get Inbox Tracks"
    )(
      connection_string=conf_database_connection_string,
      collection=conf_database_collections["tracks_inbox"],
      filter={ "status": "new" },
    )
  ) >> (
    documents_to_process := get_processing_chunk(
      documents=inbox_documents,
      chunk_size=conf_processing_chunk_size,
    )
  ) >> (
    extracted_metadata := claude_run_prompt
      .override(task_display_name="🏷️ Claude: Extract Metadata ⤴️")
      .partial(prompt=get_prompt())
      .expand(chunk=documents_to_process.map(lambda x: x["path"]))
  ) >> ( 
    split_response_res := parse_response.expand(response=extracted_metadata)
  ) >> [
    (
      normalized_date := normalize_date
        .expand(value=split_response_res.map(lambda x: x['date']))
    ),
    (
      normalized_reference := normalize_reference
        .override(map_index_template="{{ value }}")
        .partial(dictionary=dictionaly)
        .expand(value=split_response_res.map(lambda x: x['reference']))
    ),
    (
      normalized_title := normalize_title
        .expand(value=split_response_res.map(lambda x: x['title']))
    ),
    (
      normalized_author := normalize_field
        .override(task_display_name="🙋🏻‍♂️ Normalize Author")
        .partial(dictionary=dictionaly, field="author")
        .expand(value=split_response_res.map(lambda x: x['author']))
    ),
    (
      normalized_location := normalize_field
        .override(task_display_name="🌎 Normalize Location")
        .partial(dictionary=dictionaly, field="location")
        .expand(value=split_response_res.map(lambda x: x['location']))
    )
  ] >> (
    enriched_inbox_documents := enrich_inbox_document
      .expand(document_and_normalized_values=documents_to_process.zip(
        normalized_author, normalized_location,
        normalized_title, normalized_date, 
        normalized_reference))
  ) >> (
    couchdb_save_document
      .override(task_display_name="📥 CouchDB: Save Inbox")
      .partial(
        connection_string=conf_database_connection_string,
        collection=conf_database_collections["tracks_inbox"])
      .expand(document=enriched_inbox_documents)
  )

inbox_extract_metadata()
