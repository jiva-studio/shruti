from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

LECTORIUM_VAKSHUDDKI_MINIMUM_AUDIOFILES = "lectorium::vakshuddhi::minimim-audiofiles"
LECTORIUM_VAKSHUDDKI_VASTAI_QUERY = "lectorium::vakshuddhi::vastai-query"
BASE_URL = "lectorium::base-url"


# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
    LECTORIUM_VAKSHUDDKI_VASTAI_QUERY,
    "cuda_vers=12.4 num_gpus=1 gpu_name=RTX_4090 inet_down>=100 rentable=true geolocation in DE,BG,EE,FI,IT,MD,NO",
    "Vast.ai query for Vakshuddhi instance"
)

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