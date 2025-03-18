
from typing import TypedDict


class IndexDocument(TypedDict):
    _id: str
    in_title: list[str]
