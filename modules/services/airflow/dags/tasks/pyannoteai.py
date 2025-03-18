import requests

from airflow.models import Variable
from airflow.decorators import task

from pyannoteai import PyAnnoteAiJobSensor

from helpers.bucket import bucket_sign_url
from lectorium.config.pyannoteai import PYANNOTEAI_ACCESS_KEY


@task(task_display_name="📢 PyAnnoteAi: Submit Job ⤴️")
def pyannoteai_submit_job(
    bucket_object_key: str,
    speaker_count: int,
) -> str:
    pyannoteai_access_key = Variable.get(PYANNOTEAI_ACCESS_KEY)
    url_to_process = bucket_sign_url(bucket_object_key, "get")

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


@task(task_display_name="📢 PyAnnoteAi: Get Results ⤴️")
def pyannoteai_get_results(
    job_id: str,
) -> dict:
    pyannoteai_access_key = Variable.get(PYANNOTEAI_ACCESS_KEY)

    url = f"https://api.pyannote.ai/v1/jobs/{job_id}"
    headers = {"Authorization": f"Bearer {pyannoteai_access_key}"}
    response = requests.request("GET", url, headers=headers)

    return response.json()


def pyannoteai_job_sensor(
    job_id: str,
) -> PyAnnoteAiJobSensor:
    return PyAnnoteAiJobSensor(
        task_id="pyannoteai_job_sensor",
        job_id=job_id,
        access_key=Variable.get(PYANNOTEAI_ACCESS_KEY),
        mode='reschedule')


@task(task_display_name="📢 PyAnnoteAi: Get Speaker Segments ⤴️")
def pyannoteai_get_segments(
    data: dict,
    speaker_id: int,
) -> list[tuple[int, int]]:
    segments_result     = []
    segments_original   = data['output']['diarization']
    speaker_id          = "SPEAKER_" + str(speaker_id - 1).zfill(2)

    segments_group_current = []
    for segment in segments_original:
        if segment['speaker'] == speaker_id:
            segments_group_current.append((segment['start'], segment['end']))
        else:
            if segments_group_current:
                segments_result.append(segments_group_current)
                segments_group_current = []
            segments_group_current = []
    if segments_group_current:
        segments_result.append(segments_group_current)

    return segments_result
