from airflow.decorators import task

from services.aws import Credentials, SessionToken
from services.aws.actions.sign_url import sign_url


@task(
    task_display_name="🔑 AWS: Sign Url",
    multiple_outputs=False)
def sign_url(
    credentials: Credentials,
    bucket_name: str,
    object_key: str,
    method: str = "get",
    expiration: int = 3600,
) -> SessionToken:
    return sign_url(
        credentials=credentials,
        bucket_name=bucket_name,
        object_key=object_key,
        method=method,
        expiration=expiration,
    )
