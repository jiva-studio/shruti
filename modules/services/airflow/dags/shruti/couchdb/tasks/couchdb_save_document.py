from airflow.decorators import task
from requests import get, put


@task(
  task_display_name="🗄️ CouchDB: Save Document",
  map_index_template="{{ task.op_kwargs.get('document_id', None) or task.op_kwargs['document'].get('_id', None) }}",)
def couchdb_save_document(
  connection_string: str,
  collection: str,
  document: dict,
  document_id: str = None
) -> None:
  document_id = document.get("_id", document_id)
  document["_id"] = document_id
  url = f"{connection_string}/{collection}/{document_id}"

  response = get(url)
  revision = None
  if response.status_code == 200:
    stored_data = response.json()
    revision = stored_data.get("_rev")
    saving_data = {**document, "_rev": revision}
    if stored_data == saving_data:
      return

  if revision is None:
    response = put(url, json=document)
  else:
    response = put(url, json={**document, "_rev": revision})

  if response.status_code not in [200, 201]:
    raise Exception(f"Failed to save document: {response.text}")

  return document
