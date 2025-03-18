from datetime import datetime, timedelta

from airflow.models import Variable, Param
from airflow.decorators import dag, task
from airflow.utils.task_group import TaskGroup
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from lectorium.config.transcripts_proofread import PROOFREAD_PROMPT_PREFIX
from lectorium.shared import LANGUAGE_PARAMS

from tasks.bucket import bucket_download_json_data, bucket_upload_data
from tasks.claude import (
    claude_run_prompt, claude_run_batch_prompt, claude_batch_prompt_sensor,
    claude_get_batch_results
)
from tasks.transcripts import (
    transcript_split_into_chunks, transcript_enrich_chunk, transcript_enrich
)
from tasks.dag_run_notes import set_dag_run_note


@dag(
    dag_display_name="📜 Transcript: Proofread",
    description="Proofreads the extracted transcript for the given track in the given language.",
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
        "language": Param(
            default="en",
            description="Extract transcript in the given language",
            title="🇺🇸 Language",
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
def transcript_proofread():
    """
    Proofreads the extracted transcript for the given track in the given language.

    #### Input Parameters:
    - `track_id`: Track ID to process
    - `transcript_type`: Type of transcript to process (e.g., "original", "diarized")
    - `language`: Proofread transcript in the given language
    - `lane`: Select the processing lane: "normal" or "fast"
    - `chunk_size`: Number of blocks in a chunk

    #### Input File:
    - `artifacts/tracks/{track_id}/transcripts/{language}/{transcript_type}.json`: Extracted transcript

    #### Output:
    - `artifacts/tracks/{track_id}/transcripts/{language}/proofread.json`: Proofread transcript
    - `artifacts/tracks/{track_id}/transcripts/{language}/chunks/proofread/{idx}.txt`: Proofread chunks
    """

    # ---------------------------------------------------------------------------- #
    #                                    Config                                    #
    # ---------------------------------------------------------------------------- #

    conf_track_id        = "{{ params.track_id }}"
    conf_lane            = "{{ params.lane }}"
    conf_language        = "{{ params.language }}"
    conf_chunk_size      = "{{ params.chunk_size | int }}"
    conf_result_path     = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/transcripts/' ~ params.language ~ '/proofread.json' }}"
    conf_original_path   = "{{ 'artifacts/tracks/' ~ params.track_id ~ '/transcripts/' ~ params.language ~ '/' ~ params.transcript_type ~ '.json' }}"


    # ---------------------------------------------------------------------------- #
    #                                     Tasks                                    #
    # ---------------------------------------------------------------------------- #

    @task(task_display_name="🤖 Get Proofread Prompt")
    def get_proofread_prompt(language: str):
        return Variable.get(PROOFREAD_PROMPT_PREFIX + language)


    # --------------------------------- Proofread -------------------------------- #

    @task.branch(task_display_name="🚦 Select Lane")
    def select_processing_lane(lane: str):
        if lane == "fast":
            return "fast.claude_run_prompt"
        elif lane == "normal":
            return "normal.claude_run_batch_prompt"

    @task(
        task_display_name="👍 Proofreading Completed",
        trigger_rule="none_failed_min_one_success")
    def proofreading_completed(
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
            object_key = f"artifacts/tracks/{track_id}/transcripts/{language}/chunks/proofread/{idx}.txt"
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

    prompt              = get_proofread_prompt(conf_language)
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
        chunks_proofread     = proofreading_completed(fast=fast_chunks_proofread, normal=normal_chunks_proofread)
        merged_chunks        = transcript_enrich_chunk.expand(chunks=chunks_original.zip(chunks_proofread))
        transcript_proofread = transcript_enrich(transcript_original, merged_chunks)
        uploaded_files_1     = bucket_upload_data.override(task_display_name="⬆️ Bucket: Upload Transcript")(conf_result_path, transcript_proofread)
        uploaded_files_2     = transcript_chunks_upload_to_bucket(track_id=conf_track_id, chunks=chunks_proofread, language=conf_language)

        [fast_lane, normal_lane] >> enrich_transcript

    [uploaded_files_1, uploaded_files_2] >> complete(conf_result_path)

transcript_proofread()
