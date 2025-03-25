from airflow.models import Variable
from airflow.decorators import task

from anthropic import Anthropic

from lectorium.config import CLAUDE_ACCESS_KEY


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
