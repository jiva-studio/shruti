from time import sleep

from vastai import VastAI


def wait_instance_to_start(
    vast_api_key: str,
    instance_id: int,
    minutes=5,
):
    vast_sdk = VastAI(api_key=vast_api_key)

    for _ in range(minutes):
        response = vast_sdk.show_instance(id=instance_id)
        if "running" in response:
            return
        sleep(60)

    raise ValueError("Instance did not start in time.")
