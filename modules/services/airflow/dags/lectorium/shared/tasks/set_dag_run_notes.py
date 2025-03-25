from airflow.decorators import task
from airflow.models import DagRun
from airflow.settings import Session


@task(task_display_name="📝 Add Note")
def set_dag_run_note(
  dag_run: DagRun,
  note: str,
):
  session = Session()
  editable_dag_run = (
    session.query(DagRun).filter(DagRun.run_id == dag_run.run_id).one()
  )

  editable_dag_run.note = note
  session.add(editable_dag_run)
  session.commit()
