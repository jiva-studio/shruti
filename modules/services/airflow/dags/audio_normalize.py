from datetime import datetime, timedelta

from airflow.decorators import dag, task
from airflow.models import Param

from lectorium.bucket import bucket_sign_url
from lectorium.beamcloud import beam_enqueue_task, beam_task_sensor


@dag(
  schedule=None,
  start_date=datetime(2021, 1, 1),
  catchup=False,
  tags=["lectorium", "audio"],
  dag_display_name="🗣️ Audio: Normalize",
  dagrun_timeout=timedelta(minutes=60),
  default_args={
    "owner": "Advaita Krishna das",
  },
  render_template_as_native_obj=True,
  params={
    "track_id": Param(
      default="",
      description="Track ID to process",
      type="string",
      title="#️⃣ Track ID",
    ),
  },
)
def audio_normalize():

  # ---------------------------------------------------------------------------- #
  #                                   Config                                     #
  # ---------------------------------------------------------------------------- #

  conf_track_id = "{{ params.track_id }}"


  # ---------------------------------------------------------------------------- #
  #                                   Tasks                                      #
  # ---------------------------------------------------------------------------- #

  @task()
  def get_payload(
    track_id: str,
  ):
    return {
      "input": bucket_sign_url.function(f"library/audio/original/{track_id}.mp3", "get"),
      "output": bucket_sign_url.function(f"library/audio/normalized/{track_id}.mp3", "put"),
    }

  # ---------------------------------------------------------------------------- #
  #                   Tasks                  #
  # ---------------------------------------------------------------------------- #

  task_id = beam_enqueue_task(
    service="audio-enhance-e07823c-v18",
    payload=get_payload(conf_track_id)
  )
  task_id_sensor = beam_task_sensor(task_id)

  task_id >> task_id_sensor

audio_normalize()
