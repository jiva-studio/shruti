from __future__ import annotations

from datetime import datetime, timedelta
from airflow.providers.docker.operators.docker import DockerOperator

from airflow.decorators import dag
from airflow.models import Variable
from docker.types import Mount

from lectorium.config import LECTORIUM_DATABASE_CONNECTION_STRING
from lectorium.bucket import bucket_upload_file
import lectorium as lectorium


# ---------------------------------------------------------------------------- #
#                                      DAG                                     #
# ---------------------------------------------------------------------------- #

@dag(
  dag_display_name="🧰 Tools: Bundle Data",
  description="Prepares the database for distribution with the application",
  schedule='@daily',
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium"],
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

    app_bucket_name = Variable.get(lectorium.config.VAR_APP_BUCKET_NAME)
    database_connection_string = Variable.get(LECTORIUM_DATABASE_CONNECTION_STRING)

    app_bucket_creds: lectorium.config.AppBucketAccessKey = (
      Variable.get(
        lectorium.config.VAR_APP_BUCKET_ACCESS_KEY,
        deserialize_json=True
      )
    )

    files = [
      'dictionary',
      'index',
      'tracks'
    ]


    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    run_node_app = DockerOperator(
      auto_remove=True,
      mount_tmp_dir=False,
      task_id='bundle_data',
      image='ghcr.io/akdasa-studios/lectorium-data-bundler:staging',
      command='node index.js',
      docker_url='unix://var/run/docker.sock',
      network_mode='lectorium',
      mounts=[
        Mount(source='/tmp/lectorium', target='/tools/artifacts', type='bind')
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
        path=f'/tmp/lectorium/{file}.db',
        object_key=f'artifacts/bundled-data/{file}.db',
      )
      run_node_app >> uploaded_file

bake_database_for_app()