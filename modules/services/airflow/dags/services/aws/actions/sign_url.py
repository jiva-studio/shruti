import boto3
from botocore.config import Config

from services.aws import Credentials, SessionToken


def sign_url(
    credentials: Credentials,
    bucket_name: str,
    object_key: str,
    method: str = "get",
    expiration: int = 3600,
) -> SessionToken:
    s3_client = boto3.client(
        's3',
        aws_access_key_id=credentials['access_key_id'],
        aws_secret_access_key=credentials['secret_access_key'],
        endpoint_url=credentials['endpoint_url'],
        region_name=credentials['region_name'],
        config=Config(
            signature_version="s3v4",
            s3={"addressing_style": "virtual"
        }),
    )
    return s3_client.generate_presigned_url(
        f"{method}_object",
        Params={"Bucket": bucket_name, "Key": object_key},
        ExpiresIn=expiration,
    )