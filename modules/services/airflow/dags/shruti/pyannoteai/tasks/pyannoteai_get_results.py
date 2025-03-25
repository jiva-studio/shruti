import requests
from airflow.models import Variable
from airflow.decorators import task
from shruti.config.pyannoteai import PYANNOTEAI_ACCESS_KEY


@task(task_display_name="📢 PyAnnoteAi: Get Results ⤴️")
def pyannoteai_get_results(
  job_id: str,
) -> dict:
  pyannoteai_access_key = Variable.get(PYANNOTEAI_ACCESS_KEY)

  url = f"https://api.pyannote.ai/v1/jobs/{job_id}"
  headers = {"Authorization": f"Bearer {pyannoteai_access_key}"}
  response = requests.request("GET", url, headers=headers)

  return response.json()

