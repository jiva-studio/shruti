"""Pydantic DTOs — wire-format types for the HTTP API.

Kept separate from `domain/` so the domain doesn't depend on Pydantic
or the HTTP shape. Adapters in this package convert between DTOs and
domain entities at the request/response boundary.
"""
