from datetime import datetime


def get_dag_run_id(track_id: str, dag_name: str, extra: list[str] = None) -> str:
    current_datetime_string = datetime.now().strftime("%Y%m%d%H%M%S")
    extra_params = '_'.join((extra or []) + [''])
    return f"{track_id}_{dag_name}_{extra_params}{current_datetime_string}"