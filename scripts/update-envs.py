import os

# Step 1: Read the environment variables
release      = os.getenv('RELEASE', 'lectorium@dev')
dist         = os.getenv('DIST', 'dev')
sentry_dsn   = os.getenv('SENTRY_DSN', '')
api_url      = os.getenv('API_URL', 'http://localhost:8001/')
database_url = os.getenv('DATABASE_URL', 'http://localhost:5984/')
bucket_name  = os.getenv('BUCKET_NAME', 'lectorium-dev')

print(release, dist)

# Step 2: Define the content template
config = f"""
export const ENVIRONMENT = {{
  release: "{release}",
  dist: "{dist}",
  sentryDsn: "{sentry_dsn}",
  apiUrl: "{api_url}",
  databaseUrl: "{database_url}",
  bucketName: "{bucket_name}"
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