from airflow.decorators import task
from requests import post


@task(
  task_display_name="🗄️ CouchDB: Find Document")
def couchdb_find_document(
  connection_string: str,
  collection: str,
  filter: dict,
) -> None:
  url = f"{connection_string}/{collection}/_find"
  response = post(url, json={"selector": filter})
  docs = response.json().get("docs", [])
  return docs[0] if docs else None
