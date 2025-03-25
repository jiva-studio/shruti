from typing import TypedDict

from airflow.models import Variable

# ---------------------------------------------------------------------------- #
#                                      Names                                   #
# ---------------------------------------------------------------------------- #
VAR_APP_BUCKET_NAME = "shruti::bucket::name"
VAR_APP_BUCKET_GENERATE_TEMPORARY_ACCESS_KEY = "shruti::bucket::generate-temporary-access-key"
VAR_APP_BUCKET_ACCESS_KEY = "shruti::bucket::access-key"

# ---------------------------------------------------------------------------- #
#                                      Models                                  #
# ---------------------------------------------------------------------------- #

class AppBucketGenerateTempraryAccessKey(TypedDict):
  access_key_id: str
  secret_access_key: str
  region_name: str
  endpoint_url: str

class AppBucketAccessKey(TypedDict):
  access_key_id: str
  secret_access_key: str
  region_name: str
  endpoint_url: str

# ---------------------------------------------------------------------------- #
#                                       Default                                #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  VAR_APP_BUCKET_GENERATE_TEMPORARY_ACCESS_KEY,
  AppBucketGenerateTempraryAccessKey(
    access_key_id="",
    secret_access_key="",
    region_name="",
    endpoint_url="",
  ),
  "Credentials to genereate temporary access key for the app bucket",
  deserialize_json=True)

Variable.setdefault(
  VAR_APP_BUCKET_ACCESS_KEY,
  AppBucketAccessKey(
    access_key_id="",
    secret_access_key="",
    region_name="",
    endpoint_url="",
  ),
  "Credentials to access the app bucket",
  deserialize_json=True)

Variable.setdefault(
  VAR_APP_BUCKET_NAME,
  "shruti",
  "Name of the app bucket")
