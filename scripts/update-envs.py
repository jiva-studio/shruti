import os

# Step 1: Read the environment variables
release             = os.getenv('RELEASE', 'lectorium@dev')
dist                = os.getenv('DIST', 'dev')
sentry_dsn          = os.getenv('SENTRY_DSN', '')
api_url             = os.getenv('API_URL', 'http://localhost:8101/')
database_url        = os.getenv('DATABASE_URL', 'http://localhost:5984/')
bucket_name         = os.getenv('BUCKET_NAME', 'lectorium-dev')
readonly_auth_token = os.getenv('READONLY_AUTH_TOKEN', '')

# Step 2: Define the content template
config = f"""
export const ENVIRONMENT = {{
  release: "{release}",
  dist: "{dist}",
  sentryDsn: "{sentry_dsn}",
  apiUrl: "{api_url}",
  databaseUrl: "{database_url}",
  bucketName: "{bucket_name}",
  readonlyAuthToken: "{readonly_auth_token}"
}}
"""

# Step 4: Write the final content to a file
try:
  with open('./modules/apps/mobile/src/app/env.ts', 'w') as file:
    file.write(config)
  print('Config: File updated.')
except Exception as err:
  print(f'Config: Error writing to file: {err}')
  exit(0)