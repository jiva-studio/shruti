"""Hexagonal ports: Protocol-based interfaces the application depends on.

Implementations live in `lectorium_chat.infra.*`. The composition root
(`main.py:lifespan`) wires adapters to these ports at startup.
"""
