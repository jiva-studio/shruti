from requests import get


def get_document(
    connection_string: str,
    collection: str,
    document_id: str = None,
    return_empty_if_not_found: bool = False,
) -> None:
    url = f"{connection_string}/{collection}/{document_id}"
    response = get(url)
    if response.status_code != 200:
        return {} if return_empty_if_not_found else None
    return response.json()
