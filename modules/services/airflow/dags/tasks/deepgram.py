from typing import Any

from airflow.models import Variable
from airflow.decorators import task

from deepgram import DeepgramClient, PrerecordedOptions

from services.deepgram.config.variables import DEEPGRAM_ACCESS_KEY


@task(task_display_name="🔊 Deepgram: Transcribe Audio")
def deepgram_transcribe_audio_file(
    url: str,
    language: str,
) -> Any:
    deepgram_access_key = Variable.get(DEEPGRAM_ACCESS_KEY)
    deepgram_client     = DeepgramClient(deepgram_access_key).listen.prerecorded.v("1")

    response = deepgram_client.transcribe_url(
        { "url": url },
        PrerecordedOptions(
            punctuate=True,
            model="nova-2",
            language=language,
            smart_format=True,
            paragraphs=True,
        ),
    )

    return response.to_dict()
