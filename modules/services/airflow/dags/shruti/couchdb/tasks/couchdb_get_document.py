from airflow.decorators import task
from requests import get


@task(
  task_display_name="🗄️ CouchDB: Get Document",
  map_index_template="{{ task.op_kwargs['document_id'] }}",
  multiple_outputs=True)
def couchdb_get_document(
  connection_string: str,
  collection: str,
  document_id: str = None,
  return_empty_if_not_found: bool = False,
) -> None:
  url = f"{connection_string}/{collection}/{document_id}"
  response = get(url)
  if response.status_code != 200:
    return {} if return_empty_if_not_found else None
  return response.json()
