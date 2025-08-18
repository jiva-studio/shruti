from datetime import datetime, timedelta

from airflow.models import Param
from airflow.decorators import dag, task
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from lectorium.transcripts import transcript_enrich, transcript_split_into_chunks
from lectorium.shared import LANGUAGE_PARAMS

from lectorium.bucket import bucket_download_json_data, bucket_upload_data
from lectorium.claude import claude_run_prompt
from lectorium.shared import set_dag_run_note


@dag(
  dag_display_name="📜 Transcript: Translate v2",
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
    "chunk_size": Param(
      default=150,
      description="Number of blocks in a chunk",
      type="integer",
      title="✂️ Chunk Size",
    ),
  },
)
def transcript_translate_v2():
  """
  Translates transcript for the given track in the given language.

  #### Input Parameters:
  - `track_id`: Track ID to process
  - `language_translate_from`: Language translate from
  - `language_translate_into`: Language translate to
  - `chunk_size`: Number of blocks in a chunk

  #### Input File:
  - `library/tracks/{track_id}/transcripts/{language_translate_from}.json`: Transcript to translate

  #### Output:
  - `library/tracks/{track_id}/artifacts/transcripts/{language}/raw/chunks/translated/{idx}.txt`: Translated chunks
  - `library/tracks/{track_id}/transcripts/{language_translate_into}.json`: Translated transcript 
  """

  # ---------------------------------------------------------------------------- #
  #                                    Config                                    #
  # ---------------------------------------------------------------------------- #

  conf_track_id      = "{{ params.track_id }}"
  conf_language_into = "{{ params.language_translate_into }}"
  conf_chunk_size    = "{{ params.chunk_size | int }}"
  conf_original_path = "{{ 'library/tracks/' ~ params.track_id ~ '/transcripts/' ~ params.language_translate_from ~ '.json' }}"
  conf_result_path   = "{{ 'library/tracks/' ~ params.track_id ~ '/transcripts/' ~ params.language_translate_into ~ '.json' }}"


  # ---------------------------------------------------------------------------- #
  #                                     Tasks                                    #
  # ---------------------------------------------------------------------------- #

  @task(task_display_name="⬇️ Get Translation Prompt")
  def get_translate_prompt(language: str):
    prompt = """
    # Ultra-Strict Translation Prompt with Examples

    You are a professional translator. Translate the provided text **into %LANGUAGE%** while following these rules without exception:

    ---

    ## 1. Number Markers
    - Each sentence begins with a number enclosed in curly brackets, e.g., `{42}` or `{22}`.
    - **Do not** modify, move, remove, or add any markers.
    - The numbers inside the markers must remain exactly the same.

    ---

    ## 2. Translation Scope
    - Translate **only** the text that comes **after** each marker.
    - Do **not** translate the markers themselves.

    ---

    ## 3. Formatting Preservation
    - Keep all spaces, punctuation, line breaks, and text structure exactly as in the input.
    - Do not merge or split sentences.
    - The output must contain the **same number of markers** in the **same positions** as the input.

    ---

    ## 4. Output Rules
    - Return **only** the translated text with the markers untouched.
    - Do not include explanations, comments, or any extra text.

    ---

    ## 5. Examples

    **Example Input:**
    ```
    {1} Hello world. {2} This is a test.
    ```

    **✅ Correct Output:**
    ```
    {1} Привет, мир. {2} Это тест.
    ```
    - Markers are unchanged.
    - Only the text after the markers is translated.
    - Spacing and punctuation match the original.

    **❌ Incorrect Output #1 (Marker changed):**
    ```
    {1} Привет, мир. {3} Это тест.
    ```
    (❌ The second marker number `{2}` was changed to `{3}` — **invalid**.)

    **❌ Incorrect Output #2 (Marker moved):**
    ```
    {1} Привет, мир. Это тест. {2}
    ```
    (❌ The position of `{2}` changed — **invalid**.)

    **❌ Incorrect Output #3 (Extra explanation):**
    ```
    {1} Привет, мир. {2} Это тест. (Translation completed)
    ```
    (❌ Added extra text — **invalid**.)

    ---

    ## Final Instruction
    If any rule above is violated — for example, a marker is missing, moved, altered, duplicated, or extra text is added — the translation is **invalid** and must be corrected before returning it.
    """
    if language == "ru": prompt = prompt.replace("%LANGUAGE%", "Russian")
    if language == "en": prompt = prompt.replace("%LANGUAGE%", "English")
    if language == "sr": prompt = prompt.replace("%LANGUAGE%", "Serbian")
    if language == "es": prompt = prompt.replace("%LANGUAGE%", "Spanish")
    return prompt

  # ----------------------------- Upload Artifacts ----------------------------- #

  @task(task_display_name="⬆️ Upload Chunks")
  def transcript_chunks_upload_to_bucket(
    track_id: str,
    chunks: list[str],
    language: str,
  ):
    for idx, chunk in enumerate(chunks):
      object_key = f"library/tracks/{track_id}/artifacts/transcripts/{language}/raw/chunks/translated/{idx}.txt"
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
  #                                    Flow                                      #
  # ---------------------------------------------------------------------------- #

  prompt           = get_translate_prompt(conf_language_into)
  orig_transcript  = bucket_download_json_data.override(task_display_name="⬇️ Load Transcript")(conf_original_path)
  orig_chunks      = transcript_split_into_chunks(orig_transcript, conf_chunk_size)
  trans_chunks     = claude_run_prompt.partial(prompt=prompt).expand(chunk=orig_chunks)

  trans_transcript = transcript_enrich(orig_transcript, trans_chunks)
  uploaded_files_1 = bucket_upload_data.override(task_display_name="⬆️ Bucket: Upload Transcript")(conf_result_path, trans_transcript)
  uploaded_files_2 = transcript_chunks_upload_to_bucket(track_id=conf_track_id, chunks=trans_chunks, language=conf_language_into)

  [uploaded_files_1, uploaded_files_2] >> complete(conf_result_path)


transcript_translate_v2()
