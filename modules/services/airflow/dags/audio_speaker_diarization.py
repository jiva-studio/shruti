from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param
from airflow.utils.task_group import TaskGroup
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from tasks.audio import (
    audio_isolate_segments, audio_create_from_segments, audio_transcribe)
from tasks.bucket import (
    bucket_upload_data, bucket_download_file, bucket_upload_file,
    bucket_upload_file)
from tasks.pyannoteai import (
    pyannoteai_job_sensor, pyannoteai_submit_job,
    pyannoteai_get_results, pyannoteai_get_segments)
from tasks.text import text_detect_language
from tasks.dag_run_notes import set_dag_run_note


@dag(
    schedule=None,
    start_date=datetime(2021, 1, 1),
    catchup=False,
    tags=["lectorium", "audio"],
    dag_display_name="🗣️ Audio: Speaker Diarization",
    dagrun_timeout=timedelta(minutes=60),
    default_args={
        "owner": "Advaita Krishna das",
    },
    render_template_as_native_obj=True,
    params={
        "track_id": Param(
            default="",
            description="Track ID to process",
            type="string",
            title="#️⃣ Track ID",
        ),
        "audio_type": Param(
            default="normalized",
            description="Type of audio to process",
            title="🎙️ Audio Type",
            type="string",
            enum=["original", "normalized"],
            values_display={
                "original": "📼 Original",
                "normalized": "💿 Normalized",
            },
        ),
        "speakers_count": Param(
            default=2,
            description="Number of speakers in the audio file",
            type="integer",
            title="👥 Speakers",
        ),
    },
)
def audio_speaker_diarization():
    """
    Perform speaker diarization on the given track and isolate the speakers.

    #### Input Parameters:
    - `track_id`: Track ID to process
    - `audio_type`: Type of audio to process: `original` or `normalized`
    - `speakers_count`: Number of speakers in the audio file

    #### Outputs:
    - `artifact/tracks/{track_id}/audio/pyannoteai_response.json`: PyAnnoteAI response
    - `artifact/tracks/{track_id}/audio/diarization.json`: Speaker diarization report
    - `artifact/tracks/{track_id}/audio/speaker_{speaker_id}.mp3`: Isolated audio files for each speaker
    """

    # ---------------------------------------------------------------------------- #
    #                                    Config                                    #
    # ---------------------------------------------------------------------------- #

    conf_bucket_key_audio_file           = "{{ 'library/audio/' ~ params.audio_type ~ '/' ~ params.track_id ~ '.mp3' }}"
    conf_bucket_key_output_folder        = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/audio' }}"
    conf_bucket_key_diarization_response = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/audio/pyannoteai_response.json' }}"
    conf_bucket_key_diarization_report   = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/audio/diarization.json' }}"
    conf_speakers_count                  = "{{ params.speakers_count | int }}"


    # ---------------------------------------------------------------------------- #
    #                                     Tasks                                    #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="🗣️ Get Speakers")
    def get_speakers(count: int):
        return [i+1 for i in range(count)]


    @task(task_display_name="⬆️ Upload Isolated Files")
    def upload_isolated_files(
        local_file_path: tuple[str, int],
        bucket_output_folder_key: str,
    ) -> str:
        local_path, speaker_id = local_file_path
        object_key = f"{bucket_output_folder_key}/speaker_{speaker_id}.mp3"
        bucket_upload_file.function(local_path, object_key)
        return object_key


    @task(task_display_name="🧹 Cleanup")
    def cleanup(
        original_file,
        isolated_files: list[str],
        isolated_files_excepts: list[str],
    ) -> None:
        import os
        os.remove(original_file)
        for file in isolated_files:
            os.remove(file)
        for file in isolated_files_excepts:
            os.remove(file)


    @task(task_display_name="📄 Generate Report")
    def generate_report(
        speakers: list[int],
        languages: list[str],
        segments: list[tuple[int, int]],
        paths: list[str],
    ) -> dict:
        return {
            "speakers": [{
                "speaker_id": speaker,
                "language": languages[speaker - 1],
                "segments": segments[speaker - 1],
                "path": paths[speaker - 1],
            } for speaker in speakers]
        }


    @task(task_display_name="📝 Add Note")
    def add_note(
        speakers: list[int],
        languages: list[str],
        paths: list[str],
        excerpt_texts: list[str],
    ):
        note = ""
        for speaker, language, path in zip(speakers, languages, paths):
            note += f"## Speaker {speaker}\n\n"
            note += f"> ...{excerpt_texts[speaker - 1][:128]}...\n\n\n\n"
            note += f"**Language**: {language}\n\n"
            note += f"**Path**: {path}\n\n\n\n"

        context: Context = get_current_context()
        dag_run = context['dag_run']
        set_dag_run_note.function(dag_run=dag_run, note=note)


    # ---------------------------------------------------------------------------- #
    #                                     Flow                                     #
    # ---------------------------------------------------------------------------- #

    with TaskGroup("speaker_diarization") as speaker_diarization:
        diarization_job_id     = pyannoteai_submit_job(conf_bucket_key_audio_file, conf_speakers_count)
        diarization_job_sensor = pyannoteai_job_sensor(job_id=diarization_job_id)
        diarization_result_raw = pyannoteai_get_results(job_id=diarization_job_id)
        upload_diarization_raw = bucket_upload_data(conf_bucket_key_diarization_response, diarization_result_raw)
        diarization_job_id >> diarization_job_sensor >> diarization_result_raw >> upload_diarization_raw

    with TaskGroup("speaker_isolation") as speaker_isolation:
        speakers_ids            = get_speakers(count=conf_speakers_count)
        speakers_segments       = (pyannoteai_get_segments
                                    .partial(data=diarization_result_raw)
                                    .expand(speaker_id=speakers_ids))
        file_original           = bucket_download_file(conf_bucket_key_audio_file)
        files_isolated_local    = (audio_isolate_segments
                                    .partial(file=file_original)
                                    .expand(segments=speakers_segments))
        files_isolated_uploaded = (upload_isolated_files
                                    .partial(bucket_output_folder_key=conf_bucket_key_output_folder)
                                    .expand(local_file_path=files_isolated_local.zip(speakers_ids)))
        speaker_diarization >> speaker_isolation

    with TaskGroup("speaker_detect_language") as speaker_detect_language:
        files_isolated_excepts = (audio_create_from_segments
                                    .partial(file=file_original)
                                    .expand(segments=speakers_segments))
        excerpt_texts          = audio_transcribe.expand(file=files_isolated_excepts)
        languages              = text_detect_language.expand(text=excerpt_texts)
        speaker_isolation >> speaker_detect_language

    report_generated = generate_report(speakers_ids, languages, speakers_segments, files_isolated_uploaded)
    report_uploaded  = bucket_upload_data(conf_bucket_key_diarization_report, report_generated)
    add_note(speakers_ids, languages, files_isolated_uploaded, excerpt_texts)

    languages >> report_generated >> report_uploaded
    languages >> cleanup(file_original, files_isolated_local, files_isolated_excepts)


audio_speaker_diarization()
