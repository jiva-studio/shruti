from airflow.models import Variable
from airflow.decorators import task

from openai import OpenAI

from lectorium.config import OPENAI_ACCESS_KEY

@task(task_display_name="🤖 OpenAI: Run Prompt")
def openai_run_prompt(
    prompt: str,
    chunk: str = "",
    system_message: str = "",
    model: str = "gpt-5",
    max_tokens: int = 8192,
) -> str:
    openai_key = Variable.get(OPENAI_ACCESS_KEY, default_var=None)
    client = OpenAI(api_key=openai_key) if openai_key else OpenAI()


    resp = client.responses.create(
        model=model,
        max_output_tokens=max_tokens,
        instructions=system_message or None,  # system prompt
        input=[
            {
              "role": "developer",
              "content": [
                {
                  "type": "input_text",
                  "text": prompt, 
                }
              ]
            },
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": chunk},
                ],
            }
        ],
        text={
          "format": {
            "type": "text"
          },
          "verbosity": "low"
        },
        reasoning={
          "effort": "minimal"
        },
    )

    print(resp.output_text)
    return resp.output_text