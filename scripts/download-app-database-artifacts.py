import os
import boto3
from botocore.client import Config
import requests

# S3 credentials and configuration
bucket_access_key_id = os.getenv("BUCKET_ACCESS_KEY_ID")
bucket_secret_access_key = os.getenv("BUCKET_SECRET_ACCESS_KEY")
bucket_endpoint_url = os.getenv("BUCKET_ENDPOINT_URL")
bucket_region_name = os.getenv("BUCKET_REGION_NAME")
bucket_name = os.getenv("BUCKET_NAME")

# Keys to download and output directory
keys = [
    "artifacts/bundled-data/tracks.db",
    "artifacts/bundled-data/index.db",
    "artifacts/bundled-data/dictionary.db",
]
output_path = "./modules/apps/mobile/android/app/src/main/assets/databases/"

# Ensure output directory exists
os.makedirs(output_path, exist_ok=True)

# Create S3 client
s3 = boto3.client(
    "s3",
    aws_access_key_id=bucket_access_key_id,
    aws_secret_access_key=bucket_secret_access_key,
    endpoint_url=bucket_endpoint_url,
    region_name=bucket_region_name,
    config=Config(signature_version='s3v4')
)

# Download each file using signed URL
for key in keys:
    signed_url = s3.generate_presigned_url(
        'get_object',
        Params={'Bucket': bucket_name, 'Key': key},
        ExpiresIn=3600  # 1 hour
    )

    filename = os.path.basename(key)
    output_file = os.path.join(output_path, filename)

    print(f"Downloading {key} to {output_file}...")

    response = requests.get(signed_url)
    response.raise_for_status()

    with open(output_file, "wb") as f:
        f.write(response.content)

    print(f"✅ Downloaded {filename}")
