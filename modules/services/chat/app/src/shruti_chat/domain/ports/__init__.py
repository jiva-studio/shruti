"""Hexagonal ports: Protocol-based interfaces the application depends on.

Implementations live in `shruti_chat.infra.*`. The composition root
(`main.py:lifespan`) wires adapters to these ports at startup.
"""
