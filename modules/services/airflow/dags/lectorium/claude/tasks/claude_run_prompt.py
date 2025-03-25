from airflow.models import Variable
from airflow.decorators import task
from airflow.sensors.base import BaseSensorOperator
from airflow.utils.decorators import apply_defaults

from anthropic import Anthropic
from anthropic.types.beta.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.beta.messages.batch_create_params import Request

from lectorium.config import CLAUDE_ACCESS_KEY


@task(task_display_name="🤖 Claude: Run Prompt")
def claude_run_prompt(
  prompt: str,
  chunk: str = "",
  system_message: str = "",
  model: str = "claude-3-5-sonnet-20240620",
  max_tokens: int = 8192,
) -> str:
  claude_access_key = Variable.get(CLAUDE_ACCESS_KEY)
  client = Anthropic(api_key=claude_access_key)

  message = client.messages.with_raw_response.create(
    model=model,
    max_tokens=max_tokens,
    temperature=0,
    system=system_message,
    messages=[
      {
        "role": "user",
        "content": [
          {
            "type": "text",
            "text": prompt + "\n\n" + chunk,
          }
        ],
      }
    ],
    extra_headers={"anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"},
  )
  return message.parse().content[0].text


@task(task_display_name="🤖 Claude: Run Batch Prompt")
def claude_run_batch_prompt(
  prompt: str,
  chunks: list[str],
  model: str = "claude-3-5-sonnet-20240620",
  max_tokens: int = 8192,
) -> str:
  chunks = [f"{prompt}\n\n{chunk}" for chunk in chunks]

  requests = []
  for idx, prompt in enumerate(chunks):
    requests.append(Request(
      custom_id=f"{idx}",
      params=MessageCreateParamsNonStreaming(
        model=model,
        max_tokens=max_tokens,
        messages=[{
          "role": "user",
          "content": prompt,
        }]
      )
    ))

  client = Anthropic(api_key=Variable.get(CLAUDE_ACCESS_KEY))
  message_batch = client.beta.messages.batches.create(
    requests=requests,
    extra_headers={
      "anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15, message-batches-2024-09-24"
    }
  )

  return message_batch.id


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


@task(task_display_name="🤖 Claude: Get Batch Results")
def claude_get_batch_results(
  message_batch_id: str,
):
  client = Anthropic(api_key=Variable.get(CLAUDE_ACCESS_KEY))
  results = client.beta.messages.batches.results(message_batch_id)

  return [
    result.result.message.content[0].text
    for result in results
  ]
