from typing import TypedDict

from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

SHRUTI_DATABASE_CONNECTION_STRING = "shruti::database::connection-string"
SHRUTI_DATABASE_COLLECTIONS = "shruti::database::collections"

# ---------------------------------------------------------------------------- #
#                                    Models                                    #

class ShrutiDatabaseCollections(TypedDict):
  index: str
  tracks: str
  dictionary: str
  transcripts: str
  tracks_inbox: str
  tracks_sources: str

# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  SHRUTI_DATABASE_CONNECTION_STRING,
  "http://shruti:shruti@database:5984",
  "Shruti database connection string"
)

Variable.setdefault(
  SHRUTI_DATABASE_COLLECTIONS,
  ShrutiDatabaseCollections(
    tracks="tracks",
    dictionary="dictionary",
    transcripts="transcripts",
    index="index",
    tracks_inbox="inbox",
    tracks_sources="sources"
  ),
  "Database collection names",
  deserialize_json=True
)
