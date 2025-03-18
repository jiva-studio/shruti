from __future__ import annotations

from datetime import datetime, timedelta

from airflow.decorators import dag
from airflow.models import Param

from tasks.pipeline import run_track_processing_dag, wait_dag_run

import lectorium as lectorium
import lectorium.tracks_inbox


@dag(
    schedule=None,
    start_date=datetime(2021, 1, 1),
    catchup=False,
    tags=["lectorium", "tracks"],
    dag_display_name="▶️ Track: Process",
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
            **lectorium.shared.LANGUAGES_PARAMS,
        ),
        "languages_to_translate_into": Param(
            default=[],
            description="Languages to translate transcript into",
            title="Translate Into",
            **lectorium.shared.LANGUAGES_PARAMS_OPTIONAL,
        ),
        "speakers_count": Param(
            default=2,
            description="Number of speakers in the audio file",
            type="integer",
            title="👥 Speakers",
        ),
        "chunk_size": Param(
            default=150,
            description="Number of blocks in a chunk",
            type="integer",
            title="Chunk Size",
        ),
    },
)
def track_process():
    conf_track_id                    = "{{ params.track_id | string }}"
    conf_languages_in_audio_file     = "{{ params.languages_in_audio_file }}"
    conf_languages_to_translate_into = "{{ params.languages_to_translate_into }}"
    conf_speakers_count              = "{{ params.speakers_count | int }}"
    conf_audio_type                  = "normalized"


    # ---------------------------------------------------------------------------- #
    #                                     Flow                                     #
    # ---------------------------------------------------------------------------- #

    (
        audio_diarization_dag_run_id :=
            run_track_processing_dag.override(
                task_display_name="🗣️ Audio: Speaker Diarization",
            )(
                dag_id="audio_speaker_diarization",
                track_id=conf_track_id,
                conf={
                    "track_id": conf_track_id,
                    "audio_type": conf_audio_type,
                    "speakers_count": conf_speakers_count}
            )
    ) >> (
        wait_dag_run(
            dag_id="audio_speaker_diarization",
            dag_run_id=audio_diarization_dag_run_id)
    ) >> (
        transcript_extract_dag_run_id := run_track_processing_dag.override(
            task_display_name="📜 Transcript: Extract",
        )(
            dag_id="transcript_extract",
            track_id=conf_track_id,
            conf={
                "track_id": conf_track_id,
                "languages_in_audio_file": conf_languages_in_audio_file,
                "languages_to_translate_into": conf_languages_to_translate_into}
        )
    ) >> (
        wait_dag_run(
            dag_id="transcript_extract",
            dag_run_id=transcript_extract_dag_run_id)
    )

    # app_bucket_name = Variable.get(VAR_APP_BUCKET_NAME)
    # app_bucket_creds = Variable.get(VAR_APP_BUCKET_ACCESS_KEY, deserialize_json=True)
    # database_connection_string = Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)
    # database_collections: LectoriumDatabaseCollections = (
    #     Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)
    # )

    # @task
    # def get_all_languages(
    #     languages_in_audio_file: list[str],
    #     languages_to_translate_into: list[str]
    # ):
    #     return languages_in_audio_file + languages_to_translate_into


    # @task(task_display_name="⌛️ Get Transcript Extraction Tasks")
    # def get_transcript_pipeline_extract_tasks(
    #     track_id: str,
    #     languages_in_audio_file: list[str],
    #     diarization_report: dict | None,
    # ):
    #     diarization_report_exists = diarization_report is not None
    #     only_one_speaker          = len(languages_in_audio_file) == 1

    #     if not diarization_report_exists and only_one_speaker:
    #         return [{
    #             "track_id": track_id,
    #             "audio_type": "normalized",
    #             "language": languages_in_audio_file[0]
    #         }]
    #     elif diarization_report_exists and not only_one_speaker:
    #         return [{
    #             "track_id": track_id,
    #             "audio_type": "speaker_" + str(speaker["speaker_id"]),
    #             "language": speaker["language"]
    #         } for speaker in diarization_report["speakers"]]
    #     else:
    #         raise ValueError(
    #             f"Unsupported configuration: "
    #             f"languages_in_audio_file: {languages_in_audio_file} and "
    #             f"diarization_report_exists: {diarization_report_exists}")


    # @task(task_display_name="⌛️ Get Transcript Translation Tasks")
    # def get_transcript_pipeline_translate_tasks(
    #     track_id: str,
    #     languages_in_audio_file: list[str],
    #     languages_to_translate_into: list[str],
    #     diarization_report: dict | None,
    # ):
    #     if not languages_to_translate_into:
    #         return []

    #     diarization_report_exists = diarization_report is not None
    #     only_one_speaker          = len(languages_in_audio_file) == 1
    #     translate_from_language   = languages_in_audio_file[0]

    #     if not diarization_report_exists and only_one_speaker:
    #         return [{
    #             "track_id": track_id,
    #             "transcript_type": "proofread",
    #             "language_translate_from": translate_from_language,
    #             "language_translate_into": language
    #         } for language in languages_to_translate_into]
    #     elif diarization_report_exists and not only_one_speaker:
    #         return [{
    #             "track_id": track_id,
    #             "transcript_type": "diarized",
    #             "language_translate_from": translate_from_language,
    #             "language_translate_into": language
    #         } for language in languages_to_translate_into]
    #     else:
    #         raise ValueError(
    #             f"Unsupported configuration: "
    #             f"language_translate_from: {languages_in_audio_file} and "
    #             f"language_translate_into: {languages_to_translate_into} and "
    #             f"diarization_report_exists: {diarization_report_exists}")


    # @task(task_display_name="⌛️ Get Transcript Proofread Tasks")
    # def get_transcript_pipeline_proofread_tasks(
    #     track_id: str,
    #     languages_in_audio_file: list[str],
    #     diarization_report: dict | None,
    # ):
    #     diarization_report_exists = diarization_report is not None
    #     only_one_speaker          = len(languages_in_audio_file) == 1
    #     translate_from_language   = languages_in_audio_file[0]

    #     if not diarization_report_exists:
    #         return [{
    #             "track_id": track_id,
    #             "transcript_type": "original",
    #             "language": language,
    #         } for language in languages_in_audio_file]
    #     elif diarization_report_exists:
    #         return [{
    #             "track_id": track_id,
    #             "transcript_type": "diarized",
    #             "language": speaker["language"]
    #         } for speaker in diarization_report["speakers"]]

    # @task(task_display_name="⌛️ Get Transcript Diarization Task")
    # def get_transcript_pipeline_diarisation_task(
    #     track_id: str,
    #     diarization_report: dict | None,
    # ):
    #     if not diarization_report:
    #         return []

    #     return [{ "track_id": track_id }]


    # @task(
    #     task_display_name="💾 Save Track",
    #     trigger_rule="none_failed")
    # def save_track(
    #     track_inbox: TrackInbox,
    #     languages_in_audio_file: list[str],
    #     languages_translated_into: list[str],
    # ):
    #     database_connection_string = Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)
    #     database_collections = Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)

    #     track_id = track_inbox["_id"]
    #     s3_original = f"library/audio/original/{track_id}.mp3"
    #     s3_processed = f"library/audio/normalized/{track_id}.mp3"

    #     track_document = lectorium.tracks.prepare_track_document(
    #         track_id=track_id,
    #         inbox_track=track_inbox,
    #         audio_file_original_url=s3_original,
    #         audio_file_normalized_url=s3_processed,
    #         languages_in_audio_file=languages_in_audio_file,
    #         languages_translated_into=languages_translated_into)

    #     return couchdb.actions.save_document(
    #         connection_string=database_connection_string,
    #         collection=database_collections["tracks"],
    #         document=track_document)

    # @task()
    # def save_transcript(
    #     track_id: str,
    #     language: str,
    # ):
    #     print(f"tests/artifacts/{track_id}/transcripts/{language}/transcript.json")
    #     transcript = json_loads(bucket_download_file_obj(f"tests/artifacts/{track_id}/transcripts/{language}/transcript.json"))

    #     database_connection_string = Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)
    #     database_collections = Variable.get(LECTORIUM_DATABASE_COLLECTIONS, deserialize_json=True)

    #     return couchdb.actions.save_document(
    #         connection_string=database_connection_string,
    #         collection=database_collections["transcripts"],
    #         document=transcript,
    #         document_id=f"{track_id}::{language}")




    # track_inbox = load_track_inbox(track_id)

    # pipeline_speaker_diarization = process_speaker_diarization(track_id, conf_audio_type, conf_speakers_count)
    # diarization_report           = bucket_download_json_data.override(task_display_name="⬇️ Bucket: Get Diarization Report")(conf_diarization_report_path)
    # track_inbox >> pipeline_speaker_diarization >> diarization_report

    # pipeline_transcript = process_transcript_pipeline(
    #     track_id,
    #     languages_in_audio_file,
    #     languages_to_translate_into,
    #     diarization_report,
    # )
    # diarization_report >> pipeline_transcript

    # # [
    # #     pipeline_transcript_extract_tasks,
    # #     pipeline_transcript_diarization_task,
    # #     pipeline_transcript_translate_tasks,
    # #     pipeline_transcript_proofread_tasks,
    # # ] >> pipeline_transcript

    # pipeline_metadata   = process_metadata(track_id)
    # # saved_track = save_track(track_inbox, languages_in_audio_file, languages_to_translate_into)
    # # saved_transcripts = save_transcript.partial(track_id=track_id).expand(language=get_all_languages(languages_in_audio_file, languages_to_translate_into))

    # # # track_inbox >> pipeline_audio >> pipeline_transcript
    # # track_inbox >> pipeline_speaker_diarization >> [pipeline_transcript_tasks1, pipeline_transcript_tasks2] >> pipeline_transcript >> saved_track >> saved_transcripts
    # track_inbox >> pipeline_metadata



    # with TaskGroup("search_index") as group_3:
    #     @task(task_display_name="🔍 Update Search Index")
    #     def update_index():
    #         pass



    # @task(task_display_name="💾 Save Track")
    # def save_track(
    #     titles: list[str],
    # ):
    #     pass

    # saved_track = save_track(titles=transtated_titles)

    # pipeline_transcript >> saved_track
    # track_inbox >> group_2 >> saved_track >> group_3


    # @task(
    #     task_display_name="📜 Extract Transcripts ⤵️",
    #     map_index_template="{{ task.op_kwargs['language'] }}")
    # def extract_transcript(
    #     track_id: str,
    #     language: str,
    #     **kwargs,
    # ):
    #     audio_file_url = sign_url("get", f"library/audio/normalized/{track_id}.mp3")

    #     lectorium.shared.actions.run_dag(
    #         task_id="extract_transcript",
    #         trigger_dag_id="extract_transcript",
    #         wait_for_completion=True,
    #         reset_dag_run=True,
    #         dag_run_id=get_dag_run_id(track_id, "extract_transcript", [language]),
    #         dag_run_params={
    #             "track_id": track_id,
    #             "url": audio_file_url,
    #             "language": language,
    #         }, **kwargs
    #     )


    # # ---------------------------------------------------------------------------- #
    # #                                    Helpers                                   #
    # # ---------------------------------------------------------------------------- #

    # def sign_url(method: str, url: str):
    #     return aws.actions.sign_url(
    #         credentials=app_bucket_creds,
    #         bucket_name=app_bucket_name,
    #         object_key=url,
    #         method=method.lower(),
    #         expiration=60*10)

    # # ---------------------------------------------------------------------------- #
    # #                                   Language                                   #
    # # ---------------------------------------------------------------------------- #

    # @task(task_display_name="🗣️ Languages In Audio File")
    # def get_languages_in_audio_file(dag_run: DagRun):
    #     return dag_run.conf.get("languages_in_audio_file", [])

    # @task(task_display_name="🇷🇸 Translate Into")
    # def get_languages_to_translate_into(dag_run: DagRun):
    #     return dag_run.conf.get("languages_to_translate_into", [])

    # @task(task_display_name="🇬🇧 Translate From")
    # def get_language_to_translate_from(dag_run: DagRun):
    #     return dag_run.conf.get("languages_in_audio_file", [])[0]

    # ---------------------------------------------------------------------------- #
    #                                Get Track Inbox                               #
    # ---------------------------------------------------------------------------- #

    # # ---------------------------------------------------------------------------- #
    # #                                   Add Notes                                  #
    # # ---------------------------------------------------------------------------- #

    # @task(task_display_name="📝 Add Note")
    # def add_note(
    #     track_inbox: TrackInbox
    # ):
    #     """Add note to the DAG run."""
    #     base_url = Variable.get(BASE_URL)
    #     track_id = track_inbox["_id"]

    #     context: Context = get_current_context()
    #     dag_run = context['dag_run']
    #     lectorium.shared.actions.set_dag_run_note(
    #         dag_run=dag_run,
    #         note=(
    #             f"## `{track_inbox["_id"]}`\n\n"
    #             f"**Title**: {track_inbox["title"]['normalized']}\n\n"
    #             f"**Source**: {track_inbox["source"]}\n\n\n\n"
    #             f"- [📥 Inbox]({base_url}/database/_utils/#database/tracks-inbox/{track_id})\n"
    #             f"- [💾 Track]({base_url}/database/_utils/#database/library-tracks-v0001/{track_id})\n")
    #     )

    # # ---------------------------------------------------------------------------- #
    # #                              Extract Transcripts                             #
    # # ---------------------------------------------------------------------------- #

    # @task(
    #     task_display_name="📜 Extract Transcripts ⤵️",
    #     map_index_template="{{ task.op_kwargs['language'] }}")
    # def extract_transcript(
    #     track_id: str,
    #     language: str,
    #     **kwargs,
    # ):
    #     audio_file_url = sign_url("get", f"library/audio/normalized/{track_id}.mp3")

    #     lectorium.shared.actions.run_dag(
    #         task_id="extract_transcript",
    #         trigger_dag_id="extract_transcript",
    #         wait_for_completion=True,
    #         reset_dag_run=True,
    #         dag_run_id=get_dag_run_id(track_id, "extract_transcript", [language]),
    #         dag_run_params={
    #             "track_id": track_id,
    #             "url": audio_file_url,
    #             "language": language,
    #         }, **kwargs
    #     )

    # # ---------------------------------------------------------------------------- #
    # #                             Proofread Transcript                             #
    # # ---------------------------------------------------------------------------- #

    # @task(
    #     task_display_name="📜 Proofread Transcripts ⤵️",
    #     map_index_template="{{ task.op_kwargs['language'] }}")
    # def proofread_transcript(
    #     track_id: str,
    #     language: str,
    #     chunk_size: int,
    #     **kwargs,
    # ):
    #     lectorium.shared.actions.run_dag(
    #         task_id="proofread_transcript",
    #         trigger_dag_id="proofread_transcript",
    #         wait_for_completion=True,
    #         reset_dag_run=True,
    #         dag_run_id=get_dag_run_id(track_id, "proofread_transcript", [language]),
    #         dag_run_params={
    #             "track_id": track_id,
    #             "language": language,
    #             "chunk_size": chunk_size,
    #         }, **kwargs
    #     )

    # # ---------------------------------------------------------------------------- #
    # #                                  Save Track                                  #
    # # ---------------------------------------------------------------------------- #

    # @task(
    #     task_display_name="💾 Save Track",
    #     trigger_rule="none_failed")
    # def save_track(
    #     track_inbox: TrackInbox,
    #     languages_in_audio_file: list[str],
    # ):
    #     track_id = track_inbox["_id"]
    #     s3_original = f"library/audio/original/{track_id}.mp3"
    #     s3_processed = f"library/audio/normalized/{track_id}.mp3"

    #     track_document = lectorium.tracks.prepare_track_document(
    #         track_id=track_id,
    #         inbox_track=track_inbox,
    #         audio_file_original_url=s3_original,
    #         audio_file_normalized_url=s3_processed,
    #         languages_in_audio_file=languages_in_audio_file)

    #     return couchdb.actions.save_document(
    #         connection_string=database_connection_string,
    #         collection=database_collections["tracks"],
    #         document=track_document)

    # # ---------------------------------------------------------------------------- #
    # #                                Translate Track                               #
    # # ---------------------------------------------------------------------------- #

    # @task(
    #     task_display_name="📜 Translate Track ⤵️",
    #     map_index_template="{{ task.op_kwargs['language_to_translate_into'] }}")
    # def run_translate_track_dag(
    #     track_id: str,
    #     language_to_translate_from: str,
    #     language_to_translate_into: str,
    #     **kwargs,
    # ) -> tuple[str, str]:
    #     lectorium.shared.actions.run_dag(
    #         task_id="translate_track",
    #         trigger_dag_id="translate_track",
    #         wait_for_completion=True,
    #         reset_dag_run=True,
    #         dag_run_id=get_dag_run_id(
    #                         track_id, "translate_track",
    #                         [language_to_translate_from, language_to_translate_into]),
    #         dag_run_params={
    #             "track_id": track_id,
    #             "language_to_translate_from": language_to_translate_from,
    #             "language_to_translate_into": language_to_translate_into,
    #         }, **kwargs
    #     )

    # # ---------------------------------------------------------------------------- #
    # #                                 Update Index                                 #
    # # ---------------------------------------------------------------------------- #

    # @task(
    #     task_display_name="🔍 Update Search Index ⤵️",
    #     map_index_template="{{ task.op_kwargs['language'] }}",
    #     trigger_rule="none_failed_min_one_success")
    # def update_index(
    #     track_id: str,
    #     language: str,
    #     **kwargs
    # ):
    #     lectorium.shared.actions.run_dag(
    #         task_id="update_serach_index",
    #         trigger_dag_id="update_search_index",
    #         wait_for_completion=True,
    #         reset_dag_run=True,
    #         dag_run_id=get_dag_run_id(track_id, "update_search_index", [language]),
    #         dag_run_params={
    #             "track_id": track_id,
    #             "language": language,
    #         }, **kwargs
    #     )

    # # ---------------------------------------------------------------------------- #
    # #                              Archive Inbox Track                             #
    # # ---------------------------------------------------------------------------- #

    # @task(task_display_name="📦 Archive Inbox Track ⤵️")
    # def run_archive_inbox_track_dag(
    #     track_id: str,
    #     **kwargs,
    # ):
    #     lectorium.shared.actions.run_dag(
    #         task_id="archive_inbox_track",
    #         trigger_dag_id="archive_inbox_track",
    #         wait_for_completion=True,
    #         dag_run_id=get_dag_run_id(track_id, "archive_inbox_track"),
    #         dag_run_params={
    #             "track_id": track_id,
    #         }, **kwargs
    #     )

    # # ---------------------------------------------------------------------------- #
    # #                                     Done                                     #
    # # ---------------------------------------------------------------------------- #

    # @task(
    #     task_display_name="🎉 Update Track Inbox State")
    # def teardown_task(
    #     track_id: str,
    #     saved_track: Track = None,
    # ):
    #     # Load track inbox document for specified track
    #     track_inbox: TrackInbox = couchdb.actions.get_document(
    #         connection_string=database_connection_string,
    #         collection=database_collections["tracks_inbox"],
    #         document_id=track_id)

    #     # Update track inbox document status
    #     track_inbox["status"] = "done" if saved_track else "error"
    #     track_inbox["tasks"]["process_track"] = "done"

    #     # Save updated track inbox document
    #     couchdb.actions.save_document(
    #         connection_string=database_connection_string,
    #         collection=database_collections["tracks_inbox"],
    #         document=track_inbox)


    # # ---------------------------------------------------------------------------- #
    # #                                     Flow                                     #
    # # ---------------------------------------------------------------------------- #

    # (
    #     (
    #         track_inbox := get_track_inbox(track_id=track_id)
    #     ) >> [
    #         (languages_in_audio_file     := get_languages_in_audio_file()),
    #         (languages_to_translate_into := get_languages_to_translate_into()),
    #         (language_to_translate_from  := get_language_to_translate_from()),
    #     ] >> (
    #         extract_transcript
    #             .partial(track_id=track_id)
    #             .expand(language=languages_in_audio_file)
    #     ) >> (
    #         proofread_transcript
    #             .partial(
    #                 track_id=track_id,
    #                 chunk_size=chunk_size)
    #             .expand(
    #                 language=languages_in_audio_file)
    #     ) >> (
    #         saved_document := save_track(
    #             track_inbox=track_inbox,
    #             languages_in_audio_file=languages_in_audio_file)
    #     ) >> (
    #         run_translate_track_dag
    #             .partial(
    #                 track_id=track_id,
    #                 language_to_translate_from=language_to_translate_from)
    #             .expand(
    #                 language_to_translate_into=languages_to_translate_into)
    #     ) >> (
    #         update_index
    #             .partial(track_id=track_id)
    #             .expand(language=languages_in_audio_file.concat(languages_to_translate_into))
    #     ) >> (
    #         run_archive_inbox_track_dag(track_id)
    #     ) >> (
    #         teardown_task(track_id, saved_document).as_teardown()
    #     )
    # )

    # (
    #     add_note(track_inbox=track_inbox)
    # )

track_process()
