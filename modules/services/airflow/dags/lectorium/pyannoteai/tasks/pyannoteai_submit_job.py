import requests

from airflow.models import Variable
from airflow.decorators import task

from lectorium.bucket import bucket_sign_url
from lectorium.config.pyannoteai import PYANNOTEAI_ACCESS_KEY


@task(task_display_name="📢 PyAnnoteAi: Submit Job ⤴️")
def pyannoteai_submit_job(
  bucket_object_key: str,
  speaker_count: int,
) -> str:
  pyannoteai_access_key = Variable.get(PYANNOTEAI_ACCESS_KEY)
  url_to_process = bucket_sign_url.function(bucket_object_key, "get")

  payload = {
    "url": url_to_process,
    "numSpeakers": speaker_count,
    "confidence": True
  }
  headers = {
    "Authorization": f"Bearer {pyannoteai_access_key}",
    "Content-Type": "application/json"
  }

  url = "https://api.pyannote.ai/v1/diarize"
  response = requests.request("POST", url, json=payload, headers=headers)
  response = response.json()

  if "jobId" not in response:
    raise ValueError(f"Failed to submit job: {response}")

  return response["jobId"]
