from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param

from lectorium.transcripts.models.transcript import Transcript, TranscriptBlock

from lectorium.bucket import bucket_download_json_data, bucket_upload_data

@dag(
  dag_display_name="📜 Transcript: Apply Diarization",
  description="",
  start_date=datetime(2021, 1, 1),
  schedule=None,
  catchup=False,
  tags=["lectorium", "tracks", "transcripts"],
  dagrun_timeout=timedelta(minutes=60*32),
  default_args={
    "owner": "Advaita Krishna das",
  },
  params={
    "track_id": Param(
      default="",
      description="Track ID to process",
      type="string",
      title="#️⃣ Track ID",
    ),
  },
  render_template_as_native_obj=True,
)
def transcript_apply_diarization():

  # ---------------------------------------------------------------------------- #
  #                                     Config                                   #
  # ---------------------------------------------------------------------------- #

  conf_diarization_file = "'library/tracks/{{params.track_id}}/artifacts/diarization/diarization.json'"
  conf_track_id         = "{{ params.track_id }}"


  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(task_display_name="🗒️ Get Speakers Info")
  def get_speakers_info(
    diarization: dict
  ) -> list[dict]:
    return [speaker for speaker in diarization['speakers']]

  @task(
    task_display_name="⬇️ Bucket: Download Transcript",
    map_index_template="{{ speaker_info['speaker_id'] ~ '::' ~ speaker_info['language'] }}")
  def download_transcript(
    track_id: str,
    speaker_info: dict,
  ) -> Transcript:
    return bucket_download_json_data.function(
      f"library/tracks/{track_id}/artifacts/transcripts/{speaker_info['language']}/raw/deepgram_response.json"
    )

  @task(task_display_name="📜 Merge Transcript and Diarization")
  def merge(
    speaker_and_transcript: tuple[dict, Transcript]
  ) -> Transcript:
    speaker_info, transcript = speaker_and_transcript
    merged_segments = []
    transcript_result = Transcript(blocks=[])

    # merge segments
    # [ [ (start, end), (start, end) ], ... ] ->
    # [ (start, end), ... ]
    merged_segments = []
    for segment in speaker_info["segments"]:
      start = segment[0][0]
      end   = segment[-1][1]
      merged_segments.append((start, end))

    # get words from transcript related to each segment
    for start_time, end_time in merged_segments:
      words_in_segment = [
        word for word in transcript['results']['channels'][0]['alternatives'][0]['words']
        if start_time -.5 <= word['start'] < end_time
      ]
      if not words_in_segment:
        print(start_time, end_time) # no words in segment
        continue

      sentence = [word['punctuated_word'] for word in words_in_segment]
      start = words_in_segment[0]['start']
      end = words_in_segment[-1]['end']
      print(start_time, end_time, ' '.join(sentence))
      transcript_result['blocks'].append(TranscriptBlock(
        type='sentence',
        start=start,
        end=end,
        text=' '.join(sentence)
      ))

    return transcript_result

  @task(
    task_display_name="⬆️ Bucket: Upload Diarized Transcript")
  def upload_transcript(
    track_id: str,
    speaker_and_transcript: tuple[dict, Transcript]
  ):
    speaker_info, transcript = speaker_and_transcript
    bucket_upload_data.function(
      f"library/tracks/{track_id}/artifacts/transcripts/{speaker_info['language']}/diarized.json",
      transcript)
    
  # ---------------------------------------------------------------------------- #
  #                                    Flow                                      #
  # ---------------------------------------------------------------------------- #

  download_diarization_report = bucket_download_json_data\
    .override(task_display_name="⬇️ Bucket: Download Diarization Report")

  (
    diarization_file := download_diarization_report(conf_diarization_file)
  ) >> (
    speakers := get_speakers_info(diarization_file)
  ) >> (
    transcripts := download_transcript
      .partial(track_id=conf_track_id)
      .expand(speaker_info=speakers)
  ) >> (
    transcript := merge
      .expand(speaker_and_transcript=speakers.zip(transcripts))
  ) >> (
    upload_transcript
      .partial(track_id=conf_track_id)
      .expand(speaker_and_transcript=speakers.zip(transcript))
  )


transcript_apply_diarization()
