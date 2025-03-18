from typing import TypedDict


class Instance(TypedDict):
    id: int
    status: str
    hostname: str
    port: int
    label: str
