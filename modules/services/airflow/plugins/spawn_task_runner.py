from airflow.task.task_runner.base_task_runner import BaseTaskRunner
import multiprocessing
import subprocess
import os

class SpawnTaskRunner(BaseTaskRunner):
    def __init__(self, local_task_job):
        super().__init__(local_task_job)
        multiprocessing.set_start_method("spawn", force=True)

    def start(self):
        self.process = multiprocessing.Process(
            target=self._execute_task,
            args=(self._task_instance.command_as_list(),)
        )
        self.process.start()

    def _execute_task(self, command):
        subprocess.run(command, check=True, env=os.environ.copy())

    def terminate(self):
        if self.process and self.process.is_alive():
            self.process.terminate()

    def return_code(self):
        if self.process and not self.process.is_alive():
            return self.process.exitcode
        return None