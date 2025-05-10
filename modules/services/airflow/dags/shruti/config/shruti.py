from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

SHRUTI_VAKSHUDDKI_MINIMUM_AUDIOFILES = "shruti::vakshuddhi::minimim-audiofiles"
BASE_URL = "shruti::base-url"


# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  BASE_URL,
  "https://shruti.dev",
  "Base URL for Shruti"
)

Variable.setdefault(
  SHRUTI_VAKSHUDDKI_MINIMUM_AUDIOFILES,
  10,
  "Minimum number of audio files to process"
)