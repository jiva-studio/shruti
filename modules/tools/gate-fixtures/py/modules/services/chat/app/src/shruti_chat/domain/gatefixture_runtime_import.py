"""Known violation: the domain loads an adapter by name at run time."""

import importlib

fixture = importlib.import_module("shruti_chat.infra.cache")
