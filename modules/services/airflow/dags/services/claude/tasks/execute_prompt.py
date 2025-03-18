from airflow.decorators import task
from airflow.models import Variable

from anthropic import Anthropic

from services.claude.config.variables import CLAUDE_ACCESS_KEY


@task(
    task_display_name="📝 Claude :: Execute Prompt",)
def execute_prompt(
    user_message: str,
    user_message_prefix: str = "",
    system_message: str = "",
    model: str = "claude-3-5-sonnet-20240620",
    max_tokens: int = 8192,
) -> str:
    print(user_message)
    print(user_message_prefix)

    # ---------------------------------------------------------------------------- #
    #                                 Dependencies                                 #
    # ---------------------------------------------------------------------------- #

    claude_access_key = Variable.get(CLAUDE_ACCESS_KEY)
    client = Anthropic(api_key=claude_access_key)

    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

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
                        "text": user_message_prefix + user_message,
                    }
                ],
            }
        ],
        extra_headers={"anthropic-beta": "max-tokens-3-5-sonnet-2024-07-15"},
    )

    # ---------------------------------------------------------------------------- #
    #                                    Output                                    #
    # ---------------------------------------------------------------------------- #

    return message.parse().content[0].text
