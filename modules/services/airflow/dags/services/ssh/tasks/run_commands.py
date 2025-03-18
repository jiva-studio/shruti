from airflow.decorators import task

from services.ssh.actions.run_commands import run_commands as run_commands_action


@task(task_display_name="🚀 SSH: Run Commands")
def run_commands(
    url: str,
    private_key: str,
    commands: list[str],
    fail_on_stderr: bool = False,
    timeout: int = 60 * 2,
):
  run_commands_action(
      url=url,
      private_key=private_key,
      commands=commands,
      fail_on_stderr=fail_on_stderr,
      timeout=timeout,
  )
