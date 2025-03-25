from airflow.models import Variable
from airflow.sensors.base import BaseSensorOperator
from airflow.utils.decorators import apply_defaults

from anthropic import Anthropic

from lectorium.config import CLAUDE_ACCESS_KEY


def claude_batch_prompt_sensor(batch_task_id: str):
  class AntropicBatchMessageSensor(BaseSensorOperator):
    @apply_defaults
    def __init__(
      self,
      antrpoic_access_key: str,
      message_batch: str,
      *args, **kwargs
    ):
      super().__init__(*args, **kwargs)
      self.antrpoic_access_key = antrpoic_access_key
      self.message_batch = message_batch

    def poke(self, context):
      client      = Anthropic(api_key=self.antrpoic_access_key)
      message_batch_id = self.render_template(self.message_batch, context)
      message_batch_res = client.beta.messages.batches.retrieve(message_batch_id)
      return message_batch_res.processing_status == "ended"

  hour = 60*60
  return AntropicBatchMessageSensor(
    task_id="wait_for_proofread",
    mode="reschedule",
    antrpoic_access_key=Variable.get(CLAUDE_ACCESS_KEY),
    message_batch=batch_task_id,
    poke_interval=hour,
    timeout=32*hour)
