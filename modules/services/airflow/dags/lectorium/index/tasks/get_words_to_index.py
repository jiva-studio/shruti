from airflow.decorators import task

from lectorium.tracks.models.track import Track


@task(task_display_name="🗄️ Get Data to Index")
def get_words_to_index(
    track: Track,
    language: str,
) -> list[str]:

    # ----------------------------------- Title ---------------------------------- #
    index_title     = track["title"].get(language, "")

    # --------------------------------- Reference -------------------------------- #
    index_reference = ""
    for reference in track.get("references", []):
        print(reference)
        index_reference += " " + reference[0] + " "          # bg, sb, etc
        index_reference += ".".join(map(str, reference[1:])) # 1.1, 1.2, etc

    # ---------------------------------- Result ---------------------------------- #
    words = f"{index_title} {index_reference}".lower().split()
    words = list(filter(None, words))
    return set(words)
