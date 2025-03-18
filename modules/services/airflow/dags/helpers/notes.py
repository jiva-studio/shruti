from airflow.models import DagRun
from airflow.settings import Session
from airflow.utils.context import Context
from airflow.operators.python import get_current_context

from lectorium.config.lectorium import BASE_URL

def notes_dag_run_set(
    text: str,
):
    context: Context = get_current_context()
    dag_run = context['dag_run']

    session = Session()
    editable_dag_run = (
        session.query(DagRun).filter(DagRun.run_id == dag_run.run_id).one()
    )

    editable_dag_run.note = text
    session.add(editable_dag_run)
    session.commit()
