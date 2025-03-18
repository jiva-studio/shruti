from vastai import VastAI


def get_ssh_connection_to_instance(
    api_key: str,
    instance_id: int
) -> str:
    # ---------------------------------------------------------------------------- #
    #                                 Dependencies                                 #
    # ---------------------------------------------------------------------------- #

    vast_sdk = VastAI(api_key=api_key)
    ssh_url = vast_sdk.ssh_url(id=instance_id)
    print(f"SSH Url for instance {instance_id}: {ssh_url}")

    # ---------------------------------------------------------------------------- #
    #                                     Steps                                    #
    # ---------------------------------------------------------------------------- #

    return ssh_url
