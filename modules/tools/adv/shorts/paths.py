"""Where the shorts scripts keep their data: SHRUTI_RESOURCES_DIR, and nothing else."""
import os
import sys


def resources_dir() -> str:
    path = os.environ.get("SHRUTI_RESOURCES_DIR")
    if not path:
        sys.exit(
            "SHRUTI_RESOURCES_DIR is not set: point it at the directory holding "
            "daily-wisdom/, shorts/ and lake-out/."
        )
    return path
