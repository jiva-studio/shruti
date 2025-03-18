from random import choice

from services.vastai.models.instance import Instance


def get_active_instance(
    instances: list[Instance],
    label: str
) -> Instance:
    return choice([
        instance
        for instance in instances
        if instance["status"] == "running" and instance["label"] == label
    ])
