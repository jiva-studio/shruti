"""Known violation: the domain keeps process state in a module global."""

_counter = 0


def fixture() -> int:
    global _counter
    _counter += 1
    return _counter
