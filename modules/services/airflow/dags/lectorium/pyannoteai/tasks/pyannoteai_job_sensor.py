from airflow.models import Variable
from lectorium.config.pyannoteai import PYANNOTEAI_ACCESS_KEY
from pyannoteai import PyAnnoteAiJobSensor


def pyannoteai_job_sensor(
  job_id: str,
) -> PyAnnoteAiJobSensor:
  return PyAnnoteAiJobSensor(
    task_id="pyannoteai_job_sensor",
    job_id=job_id,
    access_key=Variable.get(PYANNOTEAI_ACCESS_KEY),
    mode='reschedule')
