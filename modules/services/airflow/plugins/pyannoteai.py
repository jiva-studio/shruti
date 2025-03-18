from typing import Sequence

from airflow.plugins_manager import AirflowPlugin
from airflow.sensors.base import BaseSensorOperator
from airflow.utils.decorators import apply_defaults

from requests import request


class PyAnnoteAiJobSensor(BaseSensorOperator):
    custom_operator_name = "PyAnnoteAi"
    template_fields: Sequence[str] = ("job_id",)

    @apply_defaults
    def __init__(
        self,
        job_id: str,
        access_key: str,
        *args, **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.job_id = job_id
        self.access_key = access_key

    def poke(self, context):
        url = f"https://api.pyannote.ai/v1/jobs/{self.job_id}"
        headers = {"Authorization": f"Bearer {self.access_key}"}

        response = request("GET", url, headers=headers)
        if response.status_code != 200:
            raise ValueError(f"Failed to get job: {response.text}")

        response = response.json()
        job_status = response.get("status", "unknown")
        if job_status in ["canceled", "failed"]:
            print(response)
            raise Exception(f"Job {self.job_id} failed: {job_status}")

        return job_status == "succeeded"


class PyAnnoteAiPlugin(AirflowPlugin):
    name = "pyannoteai"
    sensors = [PyAnnoteAiJobSensor]
