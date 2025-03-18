from airflow.decorators import task

from services.couchdb.actions.get_document import get_document as action_get_document


@task(
    task_display_name="🗄️ CouchDB: Get Document",
    map_index_template="{{ task.op_kwargs['document_id'] }}",
    multiple_outputs=True)
def get_document(
    connection_string: str,
    collection: str,
    document_id: str = None,
    return_empty_if_not_found: bool = False,
) -> None:
    return action_get_document(
        connection_string,
        collection,
        document_id,
        return_empty_if_not_found
    )