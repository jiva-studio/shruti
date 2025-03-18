from airflow.decorators import task
from ftlangdetect import detect


@task(task_display_name="🗣️ Text: Detect Language")
def text_detect_language(
    text: str,
) -> str:
    result = detect(text=text)
    return result["lang"]
