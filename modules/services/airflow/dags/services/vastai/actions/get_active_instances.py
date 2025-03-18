from services.vastai.models.instance import Instance


def get_active_instances(
    instances: list[Instance],
    label: str
) -> Instance:
    return [
        instance
        for instance in instances
        if instance["status"] == "running" and instance["label"] == label
    ]
