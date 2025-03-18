import boto3

from airflow.decorators import task

from services.aws import Credentials, SessionToken


@task(
    task_display_name="🔑 AWS: Delete File")
def delete_file(
    credentials: Credentials,
    bucket_name: str,
    object_key: str,
) -> SessionToken:
    s3_client = boto3.client(
        's3',
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'],
        endpoint_url=credentials['endpoint_url'],
        region_name=credentials['region_name'],
    )

    s3_client.delete_object(Bucket=bucket_name, Key=object_key)
