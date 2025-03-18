from uuid import uuid4
from io import BytesIO
from json import dumps as json_dumps, loads as json_loads

from airflow.models import Variable
from airflow.decorators import task

from boto3 import client
# from botocore.exceptions import ClientError

from lectorium.config import VAR_APP_BUCKET_ACCESS_KEY, VAR_APP_BUCKET_NAME

def __get_bucket_client():
    bucket_credentials = Variable.get(VAR_APP_BUCKET_ACCESS_KEY, deserialize_json=True)
    return client(
        's3',
        aws_access_key_id=bucket_credentials['access_key_id'],
        aws_secret_access_key=bucket_credentials['secret_access_key'],
        endpoint_url=bucket_credentials['endpoint_url'],
        region_name=bucket_credentials['region_name'])


@task(task_display_name="⬆️ Bucket: Upload Data")
def bucket_upload_data(
    object_key: str,
    data: BytesIO,
):
    object_key    = object_key.replace('//', '/')
    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()

    if isinstance(data, dict):
        data = BytesIO(json_dumps(data, ensure_ascii=False, indent=2).encode())
    if isinstance(data, str):
        data = BytesIO(data.encode("utf-8"))

    bucket_client.upload_fileobj(data, bucket_name, object_key)


@task(task_display_name="⬇️ Bucket: Download Json Data")
def bucket_download_json_data(
    object_key: str,
    raise_if_not_found: bool = True,
):
    print("Downloading: ", object_key)
    object_key    = object_key.replace('//', '/')
    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()
    try:
        response = bucket_client.get_object(Bucket=bucket_name, Key=object_key)['Body'].read()
    except bucket_client.exceptions.NoSuchKey:
        if raise_if_not_found:
            raise Exception(f"Object not found: {object_key}")
        return None
    return json_loads(response)


@task(task_display_name="⬇️ Bucket: Download File")
def bucket_download_file(
    object_key: str,
    path: str = None,
):
    if path is None:
        path = "/tmp/" + str(uuid4())

    print(f"Downloading: {object_key} to {path}")

    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()
    bucket_client.download_file(bucket_name, object_key, path)

    return path


@task(task_display_name="⬇️ Bucket: Upload File")
def bucket_upload_file(
    path: str,
    object_key: str,
):
    print(path, object_key)
    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()
    bucket_client.upload_file(path, bucket_name, object_key)


@task(task_display_name="✍️ Bucket: Sign Url")
def bucket_sign_url(
    object_key: str,
    method: str,
    expiration: int = 3600,
):
    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()

    return bucket_client.generate_presigned_url(
        f"{method}_object",
        Params={"Bucket": bucket_name, "Key": object_key},
        ExpiresIn=expiration,
    )
