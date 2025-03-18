from airflow.decorators import task

from nltk import download
from nltk.stem.snowball import SnowballStemmer


@task(task_display_name="🎋 Get Words Stems")
def get_words_stems(
    words: list[str],
    language: str,
) -> list[str]:
    download("punkt", quiet=True)
    download('stopwords', quiet=True)

    languages = {
        "en": "english",
        "ru": "russian",
        "sr": "russian",
    }

    stemmer = SnowballStemmer(
                languages[language],
                ignore_stopwords=True)
    words   = {stemmer.stem(word) for word in words}

    return list(words)
