from airflow.operators.trigger_dagrun import TriggerDagRunOperator


def run_dag(
    task_id: str,
    trigger_dag_id: str,
    dag_run_params: dict,
    wait_for_completion: bool = True,
    reset_dag_run: bool = False,
    dag_run_id: str = None,
    **kwargs
):
    trigger = TriggerDagRunOperator(
        task_id=task_id,
        trigger_dag_id=trigger_dag_id,
        conf=dag_run_params,
        reset_dag_run=reset_dag_run,
        wait_for_completion=wait_for_completion,
        trigger_run_id=dag_run_id,
    )
    trigger.execute(context=kwargs)
