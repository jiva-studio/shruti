import os

# Step 1: Read the environment variables
release             = os.getenv('RELEASE', 'lectorium@dev')
dist                = os.getenv('DIST', 'dev')
sentry_dsn          = os.getenv('SENTRY_DSN', '')
api_url             = os.getenv('API_URL', 'http://localhost:8101/')
database_url        = os.getenv('DATABASE_URL', 'http://localhost:5984/')
bucket_name         = os.getenv('BUCKET_NAME', 'lectorium-dev')
revenue_cat_key     = os.getenv('REVENUE_CAT_KEY', '')
amplitude_key       = os.getenv('AMPLITUDE_KEY', '')
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
  revenueCatKey: "{revenue_cat_key}",
  amplitudeKey: "{amplitude_key}",
  readonlyAuthToken: "{readonly_auth_token}",
  iOSClientId: "315690032552-l2vl1h7qqdidpnem255ng6v04j3icq47.apps.googleusercontent.com",
  googleWebClientId: "315690032552-hn1sgjk1m7fn38q41pupavep7idpnqoq.apps.googleusercontent.com",
}}
"""

# Step 4: Write the final content to a file
try:
  with open('./modules/apps/mobile/src/env.ts', 'w') as file:
    file.write(config)
  print('Config: File updated.')
except Exception as err:
  print(f'Config: Error writing to file: {err}')
  exit(0)