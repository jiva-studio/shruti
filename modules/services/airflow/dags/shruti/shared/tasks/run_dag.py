from datetime import datetime
from airflow.decorators import task
from airflow.operators.trigger_dagrun import TriggerDagRunOperator


def get_dag_run_id(track_id: str, dag_name: str, extra: list[str] = None) -> str:
  current_datetime_string = datetime.now().strftime("%Y%m%d%H%M%S")
  extra_params = '_'.join((extra or []) + [''])
  return f"{track_id}_{dag_name}_{extra_params}{current_datetime_string}"

@task(
  task_display_name="🤖 Run DAG ⤵️",
  multiple_outputs=False)
def run_dag(
  dag_id: str,
  track_id: str,
  conf: dict,
  **kwargs
):
  dag_run_id = get_dag_run_id(track_id, dag_id)

  TriggerDagRunOperator(
    task_id=f'trigger_{dag_id}',
    trigger_dag_id=dag_id,
    trigger_run_id=dag_run_id,
    conf=conf,
  ).execute(context=kwargs)

  return dag_run_id
