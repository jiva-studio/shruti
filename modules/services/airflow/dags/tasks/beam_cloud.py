from requests import request
from json import dumps
from typing import Sequence

from airflow.decorators import task
from airflow.models import Variable
from airflow.sensors.base import BaseSensorOperator
from airflow.utils.decorators import apply_defaults

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



def beam_task_sensor(beam_task_id: str):

    class BeamTaskSensor(BaseSensorOperator):
        custom_operator_name = "Beam.Cloud"
        template_fields: Sequence[str] = ("beam_task_id",)

        @apply_defaults
        def __init__(
            self,
            access_key: str,
            beam_task_id: str,
            *args, **kwargs
        ):
            super().__init__(*args, **kwargs)
            self.access_key = access_key
            self.beam_task_id = beam_task_id

        def poke(self, context):
            url = f"https://api.beam.cloud/v2/task/{self.beam_task_id}/"
            headers = {
                "Authorization": f"Bearer {self.access_key}",
                "Content-Type": "application/json"
            }

            response = request("GET", url, headers=headers)
            response = response.json()

            if response["status"] in ["CANCELLED", "TIMEOUT", "EXPIRED", "FAILED"]:
                raise Exception(f"Task {self.beam_task_id} failed: {response}")
            elif response["status"] in ["COMPLETE"]:
                return True

            return False

    return BeamTaskSensor(
        task_id="beam_task_sensor",
        mode="reschedule",
        access_key=Variable.get(BEAM_CLOUD_ACCESS_KEY),
        beam_task_id=beam_task_id,
        poke_interval=60,
        timeout=60*60)
