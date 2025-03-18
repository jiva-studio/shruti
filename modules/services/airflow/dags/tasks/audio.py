from uuid import uuid4

from airflow.decorators import task
from airflow.models import Variable
from pydub import AudioSegment

from lectorium.config import HUGGING_FACE_ACCESS_KEY


@task(
    task_display_name="🤐 Audio: Isolate Segments",
    multiple_outputs=False)
def audio_isolate_segments(
    file: str,
    segments: list[list[tuple[int, int]]],
) -> dict:
    audio_original = AudioSegment.from_mp3(file)
    audio_output   = AudioSegment.silent(duration=len(audio_original))
    segments_flat  = [item for sublist in segments for item in sublist]
    for start, end in segments_flat:
        audio_output = audio_output.overlay(audio_original[start*1000:end*1000], position=start*1000)

    tmp_path = "/tmp/" + str(uuid4())
    audio_output.export(tmp_path, format="mp3")
    return tmp_path


@task(
    task_display_name="🪡 Audio: Create From Segments",
    multiple_outputs=False)
def audio_create_from_segments(
    file: str,
    segments: list[list[tuple[int, int]]],
    max_duration: int = 60,
) -> str:
    audio = AudioSegment.from_mp3(file)
    result_audio = AudioSegment.empty()
    total_length = 0
    segments_flat  = [item for sublist in segments for item in sublist]
    for start, end in segments_flat:
        print(f"Getting audio form {start} to {end}")
        result_audio += audio[start*1000:end*1000]
        total_length += end - start
        if total_length >= max_duration:
            break

    tmp_path = "/tmp/" + str(uuid4())
    with open(tmp_path, "wb") as f:
        result_audio.export(f, format="mp3")
    return tmp_path


@task(
    task_display_name="🗣️ Audio: Transcribe",
    multiple_outputs=False)
def audio_transcribe(
    file: str
) -> str:
    import requests
    hugging_face_token = Variable.get(HUGGING_FACE_ACCESS_KEY)

    API_URL = "https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo"
    headers = {"Authorization": f"Bearer {hugging_face_token}"}

    with open(file, "rb") as f:
        data = f.read()
    response = requests.post(API_URL, headers=headers, data=data)
    response = response.json()
    return response["text"]
