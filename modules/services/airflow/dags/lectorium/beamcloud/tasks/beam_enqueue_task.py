from requests import request
from json import dumps

from airflow.decorators import task
from airflow.models import Variable

from lectorium.config import BEAM_CLOUD_ACCESS_KEY


@task(task_display_name="⚡️ Beam: Enqueue Task")
def beam_enqueue_task(
  service: str,
  payload: dict,
) -> str:
  access_key = Variable.get(BEAM_CLOUD_ACCESS_KEY)

  url = f"https://{service}.app.beam.cloud"
  headers = {
    "Authorization": f"Bearer {access_key}",
    "Content-Type": "application/json"
  }

  response = request(
    "POST",
    url,
    headers=headers,
    data=dumps(payload)
  ).json()
  print(response)

  return response["task_id"]

