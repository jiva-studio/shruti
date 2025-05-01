from airflow.decorators import task
from airflow.models import Variable

from lectorium.config import HUGGING_FACE_ACCESS_KEY


@task(
  task_display_name="🗣️ Audio: Transcribe",
  multiple_outputs=False)
def audio_transcribe(
  file: str
) -> str:
  import requests
  hugging_face_token = Variable.get(HUGGING_FACE_ACCESS_KEY)

  API_URL = "https://api-inference.huggingface.co/models/openai/whisper-large-v3-turbo"
  headers = {
    "Authorization": f"Bearer {hugging_face_token}",
    "Content-Type": "audio/mpeg",
  }

  with open(file, "rb") as f:
    data = f.read()
  response = requests.post(API_URL, headers=headers, data=data)
  response = response.json()
  print(response)
  return response["text"]
