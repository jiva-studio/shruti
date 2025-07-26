from __future__ import annotations

from datetime import datetime, timedelta
from airflow.providers.docker.operators.docker import DockerOperator

from airflow.decorators import dag
from airflow.models import Variable
from docker.types import Mount

from shruti.config import SHRUTI_DATABASE_CONNECTION_STRING
from shruti.bucket import bucket_upload_file
import shruti as shruti


# ---------------------------------------------------------------------------- #
#                                      DAG                                     #
# ---------------------------------------------------------------------------- #

@dag(
  dag_display_name="🧰 Tools: Bundle Data",
  description="Prepares the database for distribution with the application",
  schedule='@daily',
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["shruti"],
  dagrun_timeout=timedelta(minutes=60),
  default_args={
    "owner": "Advaita Krishna das",
  },
  render_template_as_native_obj=True,
  max_active_runs=1,
)
def bake_database_for_app():
    # ---------------------------------------------------------------------------- #
    #                                    Config                                    #
    # ---------------------------------------------------------------------------- #

    app_bucket_name = Variable.get(shruti.config.VAR_APP_BUCKET_NAME)
    database_connection_string = Variable.get(SHRUTI_DATABASE_CONNECTION_STRING)

    app_bucket_creds: shruti.config.AppBucketAccessKey = (
      Variable.get(
        shruti.config.VAR_APP_BUCKET_ACCESS_KEY,
        deserialize_json=True
      )
    )

    files = [
      'dictionary.db',
      'index.db',
      'tracks.db',
      'tracks.db-mrview-901296fddda39433e93ca2223f2f0cd6',
      'tracks.db-mrview-3b9f49811f1b73b6da3d10c5dc9876fb',
    ]


    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    run_node_app = DockerOperator(
      auto_remove=True,
      mount_tmp_dir=False,
      task_id='bundle_data',
      image='ghcr.io/akdasa-studios/shruti-data-bundler:staging',
      command='node index.js',
      docker_url='unix://var/run/docker.sock',
      network_mode='shruti',
      mounts=[
        Mount(source='/tmp/shruti', target='/tools/artifacts', type='bind')
    ],
      environment={
        'DATABASE_URI': database_connection_string,
      },
    )

    for file in files:
      uploaded_file = bucket_upload_file.override(
        task_id=f'upload_{file}_file',
        task_display_name=f'⬆️ Bucket: Upload `{file}` file',
      )(
        path=f'/tmp/shruti/{file}',
        object_key=f'artifacts/bundled-data/{file}',
      )
      run_node_app >> uploaded_file

bake_database_for_app()