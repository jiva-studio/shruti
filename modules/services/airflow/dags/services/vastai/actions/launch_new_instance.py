import json

from vastai import VastAI


def launch_new_instance(
    vast_api_key: str,
    query: str,
    image: str,
    disk: int,
    label: str,
) -> int:

    vast_sdk = VastAI(api_key=vast_api_key)

    # -------------------------------- Get Offers -------------------------------- #

    offers = vast_sdk.search_offers(
        limit=1,
        order="dlperf_usd",
        query=query,
        raw=True,
    )
    print("Offers:", offers)
    offers = json.loads(offers)
    if not offers:
        raise ValueError("No offers found.")


    # -------------------------------- Launch Instance ----------------------------- #

    create_instance_response = vast_sdk.create_instance(
        ID=offers[0]["id"],
        label=label,
        image=image,
        disk=disk,
        ssh=True,
        direct=True,
        raw=True,
    )
    print("Create instance response: ", create_instance_response)
    create_instance_response = json.loads(create_instance_response)

    if create_instance_response.get("success", False) == True:
        contract_id = create_instance_response["new_contract"]
        print(f"Instance launched successfully: {contract_id}")
        return contract_id
    else:
        raise ValueError("Failed to launch the instance.")
