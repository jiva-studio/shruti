import boto3

from airflow.decorators import task

from services.aws import Credentials, SessionToken


@task(task_display_name="🔑 AWS: Get Session Token")
def get_session_token(
    credentials: Credentials,
    duration_seconds: int = 3600,
) -> SessionToken:

    # Creating an STS client with provided credentials to get temporary access key.
    sts_client = boto3.client(
        'sts',
        endpoint_url=credentials['endpoint_url'],
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'],
        region_name=credentials['region_name']
    )

    # Making a call to STS to get a session token with the specified duration. The
    # session token will be used to access the app bucket.
    response = sts_client.get_session_token(DurationSeconds=duration_seconds)
    credentials = response['Credentials']

    return SessionToken(
        access_key_id=credentials['AccessKeyId'],
        secret_access_key=credentials['SecretAccessKey'],
        token=credentials['SessionToken'],
        expiration=credentials['Expiration']
    )
