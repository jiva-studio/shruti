from re import split

from airflow.decorators import task

from services.couchdb.actions.find_documents import find_documents


@task(task_display_name="Normalize Reference")
def normalize_reference(
    reference: str,
    language: str,
    connection_string: str,
    collection_name: str,
) -> list[str | int] | None:

    if reference is None or reference == "":
        print("No reference is provided")
        return None

    reference_tokens = split(" |\.", reference)
    reference_source = reference_tokens[0].upper()

    query = {f"name.{language}.short": reference_source}
    db_record = find_documents(
        connection_string,
        collection_name,
        query
    )

    if len(db_record) == 0:
        return None
    if len(db_record) > 1:
        return None

    return [
        db_record[0]["_id"].replace("source::", ""),
        *[int(token) if token.isdigit() else token for token in reference_tokens[1:]],
    ]
