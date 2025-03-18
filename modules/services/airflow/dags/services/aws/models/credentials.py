from datetime import datetime
from typing import TypedDict


class Credentials(TypedDict):
    access_key_id: str
    secret_access_key: str
    region_name: str
    endpoint_url: str


class SessionToken(TypedDict):
    access_key_id: str
    secret_access_key: str
    token: str
    expiration: datetime
