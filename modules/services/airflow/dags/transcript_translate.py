from datetime import datetime, timedelta

from airflow.models import Param
from airflow.decorators import dag, task
from airflow.utils.task_group import TaskGroup
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from lectorium.shared import LANGUAGE_PARAMS

from tasks.bucket import bucket_download_json_data, bucket_upload_data
from tasks.claude import (
    claude_run_prompt, claude_run_batch_prompt, claude_batch_prompt_sensor,
    claude_get_batch_results
)
from tasks.transcripts import (
    transcript_split_into_chunks, transcript_enrich
)
from tasks.dag_run_notes import set_dag_run_note


@dag(
    dag_display_name="📜 Transcript: Translate",
    description="Translates transcript for the given track in the given language.",
    start_date=datetime(2021, 1, 1),
    schedule=None,
    catchup=False,
    tags=["lectorium", "tracks", "transcripts"],
    dagrun_timeout=timedelta(minutes=60*32),
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
        "transcript_type": Param(
            default="original",
            description="Type of transcript to process",
            title="📜 Transcript Type",
            type="string",
            enum=["original", "diarized", "proofread"],
            values_display={
                "original": "📜 Original",
                "diarized": "🗒️ Diarized",
                "proofread": "🔍 Proofread",
            },
        ),
        "language_translate_from": Param(
            default="en",
            description="Translate transcript from the given language",
            title="🇺🇸 Translate From",
            **LANGUAGE_PARAMS,
        ),
        "language_translate_into": Param(
            default="en",
            description="Translate transcript into the given language",
            title="🇷🇸 Translate Into",
            **LANGUAGE_PARAMS,
        ),
        "lane": Param(
            type="string",
            title="🚦 Lane",
            description="Select the processing lane",
            enum=["normal", "fast"],
            values_display={
                "normal": "🐢 Normal",
                "fast": "🏎️ Fast",
            },
        ),
        "chunk_size": Param(
            default=150,
            description="Number of blocks in a chunk",
            type="integer",
            title="✂️ Chunk Size",
        ),
    },
)
def transcript_translate():
    """
    Translates transcript for the given track in the given language.

    #### Input Parameters:
    - `track_id`: Track ID to process
    - `transcript_type`: Type of transcript to process (e.g., "proofread")
    - `language`: Proofread transcript in the given language
    - `lane`: Select the processing lane: "normal" or "fast"
    - `chunk_size`: Number of blocks in a chunk

    #### Input File:
    - `artifacts/tracks/{track_id}/transcripts/{language}/{transcript_type}.json`: Extracted transcript

    #### Output:
    - `artifacts/tracks/{track_id}/transcripts/{language}/translated.json`: Proofread transcript
    - `artifacts/tracks/{track_id}/transcripts/{language}/chunks/translated/{idx}.txt`: Proofread chunks
    """

    # ---------------------------------------------------------------------------- #
    #                                    Config                                    #
    # ---------------------------------------------------------------------------- #

    conf_track_id      = "{{ params.track_id }}"
    conf_lane          = "{{ params.lane }}"
    conf_language_into = "{{ params.language_translate_into }}"
    conf_chunk_size    = "{{ params.chunk_size | int }}"
    conf_result_path   = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/transcripts/' ~ params.language_translate_into ~ '/translated.json' }}"
    conf_original_path = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/transcripts/' ~ params.language_translate_from ~ '/' ~ params.transcript_type ~ '.json' }}"


    # ---------------------------------------------------------------------------- #
    #                                     Tasks                                    #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="⬇️ Get Translation Prompt")
    def get_translate_prompt(language: str):
        do_not_touch_my_talala = "Each sentence starts with a number in a curly bracket. Example: {42} {22}. Keep the number in curly brackets unchanged, and do not change the value of the number. "
        prompts = {
            "en": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into English""",
            "ru": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into Russian""",
            "sr": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into Serbian""",
            "es": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into Spanish""",
        }
        if language not in prompts:
            raise ValueError(f"Unsupported language: {language}")
        return prompts[language]


    # --------------------------------- Proofread -------------------------------- #

    @task.branch(task_display_name="🚦 Select Lane")
    def select_processing_lane(lane: str):
        if lane == "fast":
            return "fast.claude_run_prompt"
        elif lane == "normal":
            return "normal.claude_run_batch_prompt"

    @task(
        task_display_name="👍 Translating Completed",
        trigger_rule="none_failed_min_one_success")
    def translating_completed(
        fast: list[str] | None,
        normal: list[str] | None
    ):
        return fast or normal


    # ----------------------------- Upload Artifacts ----------------------------- #

    @task(task_display_name="⬆️ Upload Chunks")
    def transcript_chunks_upload_to_bucket(
        track_id: str,
        chunks: list[str],
        language: str,
    ):
        for idx, chunk in enumerate(chunks):
            object_key = f"artifacts/tracks/{track_id}/transcripts/{language}/chunks/translated/{idx}.txt"
            print(f"Uploading chunk to {object_key}")
            bucket_upload_data.function(object_key=object_key, data=chunk)


    # --------------------------------- Complete --------------------------------- #

    @task(task_display_name="🏁 Complete")
    def complete(
        bucket_key_transcript_proofread: str,
    ):
        context: Context = get_current_context()
        dag_run = context['dag_run']
        set_dag_run_note.function(
            dag_run=dag_run,
            note=(
                f"### Links\n"
                f"| File         | Link                              |\n"
                f"| ------------ | --------------------------------- |\n"
                f"| Transcript   | {bucket_key_transcript_proofread} |\n"))


    # ---------------------------------------------------------------------------- #
    #                                     Flow                                     #
    # ---------------------------------------------------------------------------- #

    prompt              = get_translate_prompt(conf_language_into)
    transcript_original = bucket_download_json_data.override(task_display_name="⬇️ Load Transcript")(conf_original_path)
    chunks_original     = transcript_split_into_chunks(transcript_original, conf_chunk_size)
    processing_lane     = select_processing_lane(conf_lane)

    with TaskGroup("fast", tooltip="Fast Lane") as fast_lane:
        fast_chunks_proofread = claude_run_prompt.partial(prompt=prompt).expand(chunk=chunks_original)

    with TaskGroup("normal", tooltip="Normal Lane") as normal_lane:
        normal_proofreads_task_id = claude_run_batch_prompt(prompt=prompt, chunks=chunks_original)
        normal_proofreads_sensor  = claude_batch_prompt_sensor(normal_proofreads_task_id)
        normal_chunks_proofread   = claude_get_batch_results(normal_proofreads_task_id)
        normal_proofreads_task_id >> normal_proofreads_sensor >> normal_chunks_proofread

    prompt >> [fast_lane, normal_lane]
    chunks_original >> processing_lane >> [fast_lane, normal_lane]
    chunks_original.set_downstream([fast_lane, normal_lane])

    with TaskGroup("enrich", tooltip="Enrich the transcript") as enrich_transcript:
        chunks_translated    = translating_completed(fast=fast_chunks_proofread, normal=normal_chunks_proofread)
        transcript_proofread = transcript_enrich(transcript_original, chunks_translated)
        uploaded_files_1     = bucket_upload_data.override(task_display_name="⬆️ Bucket: Upload Transcript")(conf_result_path, transcript_proofread)
        uploaded_files_2     = transcript_chunks_upload_to_bucket(track_id=conf_track_id, chunks=chunks_translated, language=conf_language_into)

        [fast_lane, normal_lane] >> enrich_transcript

    [uploaded_files_1, uploaded_files_2] >> complete(conf_result_path)


transcript_translate()



