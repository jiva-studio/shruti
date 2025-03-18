from airflow.decorators import task
from airflow.operators.trigger_dagrun import TriggerDagRunOperator

from helpers.dags import get_dag_run_id
from multiple_dag_runs_sensor import MultipleDagRunsSensor


@task(
    task_display_name="🤖 Run DAG ⤵️",
    multiple_outputs=False)
def run_track_processing_dag(
    dag_id: str,
    track_id: str,
    conf: dict,
    **kwargs
):
    dag_run_id = get_dag_run_id(track_id, dag_id)

    operator = TriggerDagRunOperator(
        task_id=f'trigger_{dag_id}',
        trigger_dag_id=dag_id,
        trigger_run_id=dag_run_id,
        conf=conf
    ).execute(context=kwargs)

    return dag_run_id


def wait_dag_run(
    dag_id: str,
    dag_run_id: str,
    **kwargs
):
    sensor = MultipleDagRunsSensor(
        task_id=f'wait_{dag_id}',
        mode='reschedule',
        # timeout=timedelta(hours=2).total_seconds(),
        dag_run_ids=[dag_run_id],
        poke_interval=60)

    return sensor
