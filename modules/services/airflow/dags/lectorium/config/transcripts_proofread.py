from airflow.models import Variable


# ---------------------------------------------------------------------------- #
#                                     Names                                    #
# ---------------------------------------------------------------------------- #

PROOFREAD_PROMPT_PREFIX = "lectorium::proofread-prompt::"

# ---------------------------------------------------------------------------- #
#                                    Default                                   #
# ---------------------------------------------------------------------------- #

Variable.setdefault(
  PROOFREAD_PROMPT_PREFIX + "en",
  """You work as an editor of transcripts of lectures on Vedic culture. You need to correct grammar, punctuation, and other errors.
  Proofread the transcription of the audio lecture, which may contain errors:
  1. Fix any grammar, spelling, or punctuation errors.
  2. Each sentence starts with a number in a curly bracket. Example: {42} {22}. Keep the number in curly brackets unchanged, and do not change the value of the number.
  Return text.""",
  "Transript proofread prompt in English",
)

Variable.setdefault(
  PROOFREAD_PROMPT_PREFIX + "ru",
  """Проверьте транскрипцию аудиолекции, которая может содержать ошибки:
  1. Исправьте любые грамматические, орфографические или пунктуационные ошибки.
  2. Отредактируйте каждое предложение по отдельности.
  3. Каждое предложение начинается с числа в фигурных скобках. Пример: {42} {22}. Оставьте число в фигурных скобках без изменений и не меняйте значение числа.
  4. Не добавляйте в текст новый контент.
  5. Не удаляйте контент из текста.
  6. Ответ должен содержать все предложения, даже если вы не нашли никаких ошибок.
  7. Не разделяйте и не объединяйте предложения или строки.
  8. Каждая строка должна оставаться в том же порядке и строке, что и в исходном тексте.
  9. Не добавляйте никаких сводок внесенных исправлений.
  Верните весь текст, даже если вы не нашли никаких ошибок.""",
  "Transript proofread prompt in Russian",
)
