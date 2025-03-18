from airflow.models import Variable
from deepgram import DeepgramClient, PrerecordedOptions

from services.deepgram.config.variables import DEEPGRAM_ACCESS_KEY
from services.deepgram.models.transcript import Transcript, TranscriptBlock


def extract_transcript(
    url: str,
    language: str,
    model: str = "nova-2",
    smart_format: bool = True,
    paragraphs: bool = True,
) -> Transcript:
    deepgram_access_key = Variable.get(DEEPGRAM_ACCESS_KEY)
    client = DeepgramClient(deepgram_access_key)

    # ----------------------------- Extract Transcript---------------------------- #

    client = client.listen.prerecorded.v("1")
    response = client.transcribe_url(
        { "url": url },
        PrerecordedOptions(
            punctuate=True,
            model=model,
            language=language,
            smart_format=smart_format,
            utterances=True,
            utt_split=0.8,
            paragraphs=paragraphs,
        ),
    )

    # ------------------------------- Parse Response ----------------------------- #

    blocks = []
    first_channel = response["results"]["channels"][0]
    first_alternative = first_channel["alternatives"][0]["paragraphs"]
    paragraphs = first_alternative["paragraphs"]

    for paragraph in paragraphs:
        blocks.extend(
            [
                TranscriptBlock(
                    type="sentence",
                    text=sentence["text"],
                    start=float(sentence["start"]),
                    end=float(sentence["end"]),
                )
                for sentence in paragraph["sentences"]
            ]
        )

        blocks.append(TranscriptBlock(type="paragraph"))

    # ---------------------------------- Output ---------------------------------- #

    return Transcript(
        version=1,
        blocks=blocks,
        language=language,
    )
