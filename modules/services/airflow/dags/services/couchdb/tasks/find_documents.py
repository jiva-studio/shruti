from requests import post

from airflow.decorators import task


@task(
    task_display_name="🗄️ CouchDB: Find Documents")
def find_documents(
    connection_string: str,
    collection: str,
    filter: dict,
) -> None:
    url = f"{connection_string}/{collection}/_find"
    response = post(url, json={"selector": filter})
    docs = response.json().get("docs", [])
    return docs