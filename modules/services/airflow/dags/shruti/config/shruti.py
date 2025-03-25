from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

SHRUTI_VAKSHUDDKI_MINIMUM_AUDIOFILES = "shruti::vakshuddhi::minimim-audiofiles"
SHRUTI_VAKSHUDDKI_VASTAI_QUERY = "shruti::vakshuddhi::vastai-query"
BASE_URL = "shruti::base-url"


# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  SHRUTI_VAKSHUDDKI_VASTAI_QUERY,
  "cuda_vers=12.4 num_gpus=1 gpu_name=RTX_4090 inet_down>=100 rentable=true geolocation in DE,BG,EE,FI,IT,MD,NO",
  "Vast.ai query for Vakshuddhi instance"
)

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