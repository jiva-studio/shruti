from airflow.models import Variable
from airflow.decorators import task

from anthropic import Anthropic
from anthropic.types.beta.message_create_params import MessageCreateParamsNonStreaming
from anthropic.types.beta.messages.batch_create_params import Request

from lectorium.config import CLAUDE_ACCESS_KEY


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
