from airflow.decorators import task


@task(
    task_display_name="Get Extract Meta Prompt",
    multiple_outputs=False)
def get_extract_meta_prompt(
    language: str,
) -> str:
    return {
        "en": """
            Here is a path to the file. Extract information from it and return the result as: <author>|<topic>|<date YYYYMMDD>|<location>|<verse number>.
            Leave the field blank if there is no information about it. Return an empty string if you are unclear at all. Ignore #hashtags.
            Use | as the delimiter. The verse number might be in the following format: BG 2.14, SB 1.2.3, CC Adi 1.2.3, etc.""",
        "ru": """
            Вот путь к файлу. Извлеките информацию из него и верните результат в виде одной строки в формате: <автор>|<тема>|<дата ГГГГММДД>|<место>|<номер стиха>. Никакой дополнительной информации не нужно.
            Оставьте поле пустым, если информации о нем нет. Верните пустую строку, если вам все непонятно. Игнорируйте #хэштеги.
            Используйте | в качестве разделителя.

            <номер стиха> может быть в формате: БГ 2.14, ШБ 1.2.3, ЧЧ Ади 1.2.3 и т. д.
            Если <номер стиха> содержит раздлитель то убрать: "Ш Б 10.10.11" -> "ШБ 10.10.11", "Б.Г. 1.12" -> "БГ 1.12"

            Примеры локаций: Вриндаван, Майапур
            Пример дат: 20050213, 13/02/2005
            Пример имен: Аиндра дас, Ватсала дас, Нитьянанда Чаран дас
            В именах "прабху" заменяй на "дас" и убирай приставки "ЕМ" и "ЕС"
            """,
    }[language]
