from typing import TypedDict

from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

LECTORIUM_DATABASE_CONNECTION_STRING = "lectorium::database::connection-string"
LECTORIUM_DATABASE_COLLECTIONS = "lectorium::database::collections"

# ---------------------------------------------------------------------------- #
#                                    Models                                    #

class LectoriumDatabaseCollections(TypedDict):
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
    LECTORIUM_DATABASE_CONNECTION_STRING,
    "http://lectorium:lectorium@database:5984",
    "Lectorium database connection string"
)

Variable.setdefault(
    LECTORIUM_DATABASE_COLLECTIONS,
    LectoriumDatabaseCollections(
        tracks="library-tracks-v0001",
        dictionary="library-dictionary-v0001",
        transcripts="library-transcripts-v0001",
        index="library-index-v0001",
        tracks_inbox="tracks-inbox",
        tracks_sources="tracks-sources"
    ),
    "Database collection names",
    deserialize_json=True
)
