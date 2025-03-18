from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

VASTAI_ACCESS_KEY = "vastai::access-key"
VASTAI_PRIVATE_SSH_KEY = "vastai::private-ssh-key"


# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
    VASTAI_ACCESS_KEY,
    "",
    "Vast.ai access key"
)


Variable.setdefault(
    VASTAI_PRIVATE_SSH_KEY,
    "",
    "Vast.ai private SSH key"
)
