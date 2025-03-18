from __future__ import annotations

from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param
from airflow.operators.trigger_dagrun import TriggerDagRunOperator

from multiple_dag_runs_sensor import MultipleDagRunsSensor

from tasks.bucket import bucket_download_json_data
from helpers.dags import get_dag_run_id
from lectorium.shared import LANGUAGES_PARAMS, LANGUAGES_PARAMS_OPTIONAL


@dag(
    schedule=None,
    start_date=datetime(2021, 1, 1),
    catchup=False,
    tags=["lectorium", "tracks", "transcript"],
    dag_display_name="📜 Transcript: Extract",
    dagrun_timeout=timedelta(minutes=60*48),
    default_args={
        "owner": "Advaita Krishna das",
    },
    render_template_as_native_obj=True,
    params={
        "track_id": Param(
            default="",
            description="Track ID to process",
            type="string",
            title="Track ID",
        ),
        "languages_in_audio_file": Param(
            default=["en"],
            description="Languages present in the audio file. First language will be used for translating transcripts into other languages",
            title="Languages",
            **LANGUAGES_PARAMS,
        ),
        "languages_to_translate_into": Param(
            default=[],
            description="Languages to translate transcript into",
            title="Translate Into",
            **LANGUAGES_PARAMS_OPTIONAL,
        ),
    },
)
def transcript_extract():
    """
    Extracts transcript from audio file, applies diarization, proofreads and translates it into other languages.

    #### Input Parameters:
    - `track_id`: Track ID to process
    - `languages_in_audio_file`: Languages present in the audio file. First language will be used for translating transcripts into other languages
    - `languages_to_translate_into`: Languages to translate transcript into

    #### Input Files:
    - `artifact/tracks/{track_id}/audio/diarization.json`: Speaker diarization report

    #### Output Files:
    - `artifacts/tracks/{track_id}/transcripts/{language}/original.json`: Extracted transcript
    - `artifacts/tracks/{track_id}/transcripts/{language}/transcript.json`: Proofread or translated transcript
    """

    # ---------------------------------------------------------------------------- #
    #                                    Config                                    #
    # ---------------------------------------------------------------------------- #

    conf_track_id                    = "{{ params.track_id | string }}"
    conf_languages_in_audio_file     = "{{ params.languages_in_audio_file }}"
    conf_languages_to_translate_into = "{{ params.languages_to_translate_into }}"
    conf_diarization_report_path     = "artifacts/tracks/{{ params.track_id }}/audio/diarization.json"

    # ---------------------------------------------------------------------------- #
    #                           Tasks: Extract Transcript                          #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="📜 Transcript: Transcribe Audio ⤵️")
    def run_transcript_transcribe_audio_dag(
        track_id: str,
        languages_in_audio_file: list[str],
        diarization_report: dict | None,
        **kwargs
    ) -> list[str]:
        run_dags_params           = []
        diarization_report_exists = diarization_report is not None
        only_one_speaker          = len(languages_in_audio_file) == 1

        if not diarization_report_exists and only_one_speaker:
            run_dags_params = [{
                "track_id": track_id,
                "audio_type": "normalized",
                "language": languages_in_audio_file[0]
            }]
        elif diarization_report_exists and not only_one_speaker:
            run_dags_params = [{
                "track_id": track_id,
                "audio_type": "speaker_" + str(speaker["speaker_id"]),
                "language": speaker["language"]
            } for speaker in diarization_report["speakers"]]
        else:
            raise ValueError(
                f"Unsupported configuration: "
                f"languages_in_audio_file: {languages_in_audio_file} and "
                f"diarization_report_exists: {diarization_report_exists}")

        run_dags_ids = [
            get_dag_run_id(
                track_id,
                "transcript_extract_from_audio",
                [params["language"]]
            ) for params in run_dags_params
        ]

        for id, params in zip(run_dags_ids, run_dags_params):
            TriggerDagRunOperator(
                task_id='trigger_extract_transcript',
                trigger_dag_id='transcript_transcribe_audio',
                trigger_run_id=id,
                conf=params
            ).execute(context=kwargs)

        return run_dags_ids

    # ---------------------------------------------------------------------------- #
    #                              Tasks: Diarization                              #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="📜 Transcript: Apply Diarization ⤵️")
    def run_transcript_apply_diarization_dag(
        track_id: str,
        diarization_report: dict | None,
        **kwargs
    ) -> list[str]:
        if not diarization_report:
            return []

        dag_run_id = get_dag_run_id(track_id, "transcript_apply_diarization")

        a = TriggerDagRunOperator(
            task_id='trigger_transcript_apply_diarization',
            trigger_dag_id='transcript_apply_diarization',
            trigger_run_id=dag_run_id,
            conf={ "track_id": track_id }
        ).execute(context=kwargs)

        return [dag_run_id]

    # ---------------------------------------------------------------------------- #
    #                               Tasks: Proofread                               #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="📜 Transcript: Proofread ⤵️")
    def run_transcript_proofread_dag(
        track_id: str,
        languages_in_audio_file: list[str],
        diarization_report: dict | None,
        **kwargs
    ):
        run_dags_params = []
        diarization_report_exists = diarization_report is not None

        if not diarization_report_exists:
            run_dags_params = [{
                "track_id": track_id,
                "transcript_type": "original",
                "language": language,
            } for language in languages_in_audio_file]
        elif diarization_report_exists:
            run_dags_params = [{
                "track_id": track_id,
                "transcript_type": "diarized",
                "language": speaker["language"]
            } for speaker in diarization_report["speakers"]]

        run_dags_ids = [
            get_dag_run_id(
                track_id,
                "transcript_proofread",
                [params["language"]]
            ) for params in run_dags_params
        ]

        for id, params in zip(run_dags_ids, run_dags_params):
            TriggerDagRunOperator(
                task_id='trigger_transcript_proofread',
                trigger_dag_id='transcript_proofread',
                trigger_run_id=id,
                conf={
                    **params,
                    "lane": "fast",
                    "chunk_size": 150,
                }).execute(context=kwargs)
        return run_dags_ids

    # ---------------------------------------------------------------------------- #
    #                               Tasks: Translate                               #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="📜 Transcript: Translate ⤵️")
    def run_transcript_translate_dag(
        track_id: str,
        languages_in_audio_file: list[str],
        languages_to_translate_into: list[str],
        diarization_report: dict | None,
        **kwargs
    ):
        if not languages_to_translate_into:
            return []

        run_dags_params = []
        diarization_report_exists = diarization_report is not None
        only_one_speaker          = len(languages_in_audio_file) == 1
        translate_from_language   = languages_in_audio_file[0]

        if not diarization_report_exists and only_one_speaker:
            run_dags_params = [{
                "track_id": track_id,
                "transcript_type": "proofread",
                "language_translate_from": translate_from_language,
                "language_translate_into": language
            } for language in languages_to_translate_into]
        elif diarization_report_exists and not only_one_speaker:
            run_dags_params = [{
                "track_id": track_id,
                "transcript_type": "diarized",
                "language_translate_from": translate_from_language,
                "language_translate_into": language
            } for language in languages_to_translate_into]
        else:
            raise ValueError(
                f"Unsupported configuration: "
                f"language_translate_from: {languages_in_audio_file} and "
                f"language_translate_into: {languages_to_translate_into} and "
                f"diarization_report_exists: {diarization_report_exists}")

        run_dags_ids = [
            get_dag_run_id(
                track_id,
                "transcript_transcript_translate",
                [params["language_translate_from"], params["language_translate_into"]]
            ) for params in run_dags_params
        ]

        for id, params in zip(run_dags_ids, run_dags_params):
            TriggerDagRunOperator(
                task_id='trigger_transcript_translate',
                trigger_dag_id='transcript_translate',
                wait_for_completion=False,
                trigger_run_id=id,
                conf={
                    **params,
                    "lane": "fast",
                    "chunk_size": 150,
                }).execute(context=kwargs)
        return run_dags_ids

    # ---------------------------------------------------------------------------- #
    #                                     Flow                                     #
    # ---------------------------------------------------------------------------- #

    get_diarization_report = bucket_download_json_data.override(task_display_name="⬇️ Bucket: Get Diarization Report")

    (
        diarization_report :=
            get_diarization_report(
                object_key=conf_diarization_report_path,
                raise_if_not_found=False)
    ) >> (
        dag_run_transcribe_ids :=
            run_transcript_transcribe_audio_dag(
                track_id=conf_track_id,
                languages_in_audio_file=conf_languages_in_audio_file,
                diarization_report=diarization_report)
    ) >> (
        MultipleDagRunsSensor(
            task_id='sensor_transcribe_audio',
            mode='reschedule',
            timeout=timedelta(hours=2).total_seconds(),
            dag_run_ids=dag_run_transcribe_ids,
            poke_interval=60)
    ) >> (
        dag_run_diarization_ids :=
            run_transcript_apply_diarization_dag(
                track_id=conf_track_id,
                diarization_report=diarization_report)
    ) >> (
        MultipleDagRunsSensor(
            task_id='sensor_apply_diarisation',
            mode='reschedule',
            timeout=timedelta(hours=2).total_seconds(),
            dag_run_ids=dag_run_diarization_ids,
            poke_interval=60)
    ) >> (
        dag_run_proofread_ids :=
            run_transcript_proofread_dag(
                track_id=conf_track_id,
                languages_in_audio_file=conf_languages_in_audio_file,
                diarization_report=diarization_report)
    ) >> (
        MultipleDagRunsSensor(
            task_id='sensor_proofread_transcript',
            mode='reschedule',
            timeout=timedelta(hours=2).total_seconds(),
            dag_run_ids=dag_run_proofread_ids,
            poke_interval=60)
    ) >> (
        dag_run_translation_ids :=
            run_transcript_translate_dag(
                track_id=conf_track_id,
                languages_in_audio_file=conf_languages_in_audio_file,
                languages_to_translate_into=conf_languages_to_translate_into,
                diarization_report=diarization_report)
    ) >> (
        MultipleDagRunsSensor(
            task_id='sensor_translate_transcript',
            mode='reschedule',
            timeout=timedelta(hours=2).total_seconds(),
            dag_run_ids=dag_run_translation_ids,
            poke_interval=60)
    )

transcript_extract()
