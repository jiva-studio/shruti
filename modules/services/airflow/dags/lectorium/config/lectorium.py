from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

LECTORIUM_VAKSHUDDKI_MINIMUM_AUDIOFILES = "lectorium::vakshuddhi::minimim-audiofiles"
BASE_URL = "lectorium::base-url"


# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  BASE_URL,
  "https://lectorium.dev",
  "Base URL for Lectorium"
)

Variable.setdefault(
  LECTORIUM_VAKSHUDDKI_MINIMUM_AUDIOFILES,
  10,
  "Minimum number of audio files to process"
)