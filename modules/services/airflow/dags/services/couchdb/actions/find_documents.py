from requests import post


def find_documents(
    connection_string: str,
    collection: str,
    filter: dict
) -> None:
    url = f"{connection_string}/{collection}/_find"
    params = {'selector': filter, "limit": 256}
    headers = {'Content-Type': 'application/json'}
    response = post(url, json=params, headers=headers)
    if response.status_code != 200:
        return []
    return response.json().get('docs', [])
