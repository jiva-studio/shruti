from airflow.decorators import task


@task(
    task_display_name="🗄️ CouchDB: Patch Document")
def patch_document(
    document: dict,
    data: dict
) -> None:
    document.update(data)
    return document

