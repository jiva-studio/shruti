import boto3
from airflow.decorators import task
from services.aws import Credentials


@task(
    task_display_name="⚖️ AWS: Get File Size",
    multiple_outputs=False)
def get_file_size(
    credentials: Credentials,
    bucket_name: str,
    object_key: str,
) -> int:
    s3_client = boto3.client(
        's3',
        endpoint_url=credentials['endpoint_url'],
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'],
        region_name=credentials['region_name']
    )

    response = s3_client.head_object(Bucket=bucket_name, Key=object_key)
    file_size = response['ContentLength']

    return file_size
