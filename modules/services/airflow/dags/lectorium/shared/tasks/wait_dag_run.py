from multiple_dag_runs_sensor import MultipleDagRunsSensor

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
