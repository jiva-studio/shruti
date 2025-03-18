import boto3

from airflow.decorators import task

from services.aws import Credentials, SessionToken


@task(
    task_display_name="🔑 AWS: Upload File",
    multiple_outputs=False)
def upload_file(
    credentials: Credentials,
    bucket_name: str,
    object_key: str,
    file_path: str,
) -> SessionToken:
    s3_client = boto3.client(
        's3',
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'],
        endpoint_url=credentials['endpoint_url'],
        region_name=credentials['region_name'],
    )

    s3_client.upload_file(file_path, bucket_name, object_key)
