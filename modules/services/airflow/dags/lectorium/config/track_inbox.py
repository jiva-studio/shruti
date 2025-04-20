from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

LECTROIUM_TRACK_INBOX_LAST_SCAN = "lectorium::inbox::last-scan-date"
LECTROIUM_TRACK_INBOX_PROCESSING_CHUNK_SIZE = "lectorium::inbox::processing-chunk-size"


# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  LECTROIUM_TRACK_INBOX_LAST_SCAN,
  "0",
  "Last inbox scan date (timestamp)"
)

Variable.setdefault(
  LECTROIUM_TRACK_INBOX_PROCESSING_CHUNK_SIZE,
  "32",
  "Processing chunk size (number of files to process at once)"
)
