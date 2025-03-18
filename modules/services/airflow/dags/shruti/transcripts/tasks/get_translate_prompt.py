from airflow.decorators import task


@task(task_display_name="🌍 Get Translate Prompt")
def get_translate_prompt(
    language: str,
) -> str:
    do_not_touch_my_talala = "Each sentence starts with a number in a curly bracket. Example: {0:42} {1:22}. Keep the number in curly brackets unchanged, and do not change the value of the number. "

    prompts = {
        "en": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into English""",
        "ru": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into Russian""",
        "sr": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into Serbian""",
        "es": f"""You a working as professional translator. You should translate text and return whole translated text. {do_not_touch_my_talala} Translate into Spanish""",
    }

    if language not in prompts:
        raise ValueError(f"Unsupported language: {language}")

    return prompts[language]
