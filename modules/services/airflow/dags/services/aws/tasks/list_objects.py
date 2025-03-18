import boto3

from airflow.decorators import task

from services.aws import Credentials, SessionToken


@task(
    task_display_name="🔑 AWS: List Objects",
    multiple_outputs=False)
def list_objects(
    credentials: Credentials,
    bucket_name: str,
    prefix: str,
) -> SessionToken:
    result = []

    s3_client = boto3.client(
        's3',
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'],
        endpoint_url=credentials['endpoint_url'],
        region_name=credentials['region_name'],
    )

    paginator = s3_client.get_paginator('list_objects_v2')

    # Paginate through the folder's contents
    for page in paginator.paginate(Bucket=bucket_name, Prefix=prefix):
        for obj in page.get('Contents', []):
            if (obj['Size'] == 0):
                continue # skip folders
            result.append(obj['Key'])

    return result
