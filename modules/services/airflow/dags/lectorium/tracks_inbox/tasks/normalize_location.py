from airflow.decorators import task

from services.couchdb.actions.find_documents import find_documents

@task(task_display_name="Normalize Location")
def normalize_location(
    location_name: str,
    language: str,
    connection_string: str,
    collection_name: str,
) -> str:
    if not location_name:
        return None

    query = {f"name.{language}": location_name}
    location_db_record = find_documents(
        connection_string,
        collection_name,
        query
    )

    if len(location_db_record) == 1:
        return location_db_record[0]["_id"].replace("location::", "")
    else:
        return None
