from __future__ import annotations

from boto3 import client
from io import BytesIO
from airflow.models import Variable
from lectorium.config import VAR_APP_BUCKET_ACCESS_KEY, VAR_APP_BUCKET_NAME


def __get_bucket_client():
    bucket_credentials = Variable.get(VAR_APP_BUCKET_ACCESS_KEY, deserialize_json=True)
    return client(
        's3',
        aws_access_key_id=bucket_credentials['access_key_id'],
        aws_secret_access_key=bucket_credentials['secret_access_key'],
        endpoint_url=bucket_credentials['endpoint_url'],
        region_name=bucket_credentials['region_name'])


def bucket_upload_file_obj(
    object_key: str,
    data: BytesIO,
):
    object_key    = object_key.replace('//', '/')
    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()
    bucket_client.upload_fileobj(data, bucket_name, object_key)


def bucket_download_file_obj(
    object_key: str,
):
    bucket_name   = Variable.get(VAR_APP_BUCKET_NAME)
    bucket_client = __get_bucket_client()
    return bucket_client.get_object(Bucket=bucket_name, Key=object_key)['Body'].read()


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
