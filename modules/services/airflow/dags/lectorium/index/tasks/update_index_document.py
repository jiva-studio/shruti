from airflow.decorators import task

from lectorium.index.models.index_document import IndexDocument


@task(
    task_display_name="🗄️ Update Index Document",
    map_index_template="{{ task.op_kwargs['word_index_document'][0] }}")
def update_index_document(
    track_id: str,
    word_index_document: tuple[str, IndexDocument | None],
) -> list[str]:
    print(track_id)
    print(word_index_document)

    word     = word_index_document[0]
    document = word_index_document[1]

    if "_id" not in document:
        document["_id"] = f"index::{word}"
    if "in_title" not in document:
        document["in_title"] = []

    indexed = set(document["in_title"])
    indexed.add(track_id)

    document["in_title"] = list(indexed)

    return document

