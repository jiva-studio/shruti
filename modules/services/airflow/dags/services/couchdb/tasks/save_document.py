from airflow.decorators import task

from services.couchdb.actions.save_document import save_document as action_save_document


@task(
    task_display_name="🗄️ CouchDB: Save Document",
    map_index_template="{{ task.op_kwargs.get('document_id', None) or task.op_kwargs['document'].get('_id', None) }}",)
def save_document(
    connection_string: str,
    collection: str,
    document: dict,
    document_id: str = None
) -> None:
    return action_save_document(connection_string, collection, document, document_id)
