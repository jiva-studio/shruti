from airflow.models import DagRun
from airflow.plugins_manager import AirflowPlugin
from airflow.sensors.base import BaseSensorOperator
from airflow.utils.decorators import apply_defaults
from airflow.utils.state import State


class MultipleDagRunsSensor(BaseSensorOperator):
    @apply_defaults
    def __init__(
        self, dag_run_ids: list[str],
        *args, **kwargs
    ):
        super().__init__(*args, **kwargs)
        self.dag_run_ids = dag_run_ids

    def poke(self, context):
        dag_run_ids = self.render_template(self.dag_run_ids, context)
        for dag_run_id in dag_run_ids:
            dag_runs = DagRun.find(run_id=dag_run_id, state=State.SUCCESS)
            if not dag_runs:
                print(f"DAG {dag_run_id} is not completed yet.")
                return False
        return True


class MultipleDagRunsSensorPlugin(AirflowPlugin):
    name = "multiple_dag_runs_sensor"
    sensors = [MultipleDagRunsSensor]
