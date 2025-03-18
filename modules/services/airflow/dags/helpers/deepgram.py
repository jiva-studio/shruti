from typing import Any

from airflow.models import Variable
from deepgram import DeepgramClient, PrerecordedOptions

from services.deepgram.config.variables import DEEPGRAM_ACCESS_KEY


def deepgram_transcribe_audio_file(
    url: str,
    language: str,
) -> Any:
    deepgram_access_key = Variable.get(DEEPGRAM_ACCESS_KEY)
    deepgram_client     = DeepgramClient(deepgram_access_key).listen.prerecorded.v("1")

    return deepgram_client.transcribe_url(
        { "url": url },
        PrerecordedOptions(
            punctuate=True,
            model="nova-2",
            language=language,
            smart_format=True,
            paragraphs=True,
            utterances=True,
            utt_split=0.8,
        ),
    )