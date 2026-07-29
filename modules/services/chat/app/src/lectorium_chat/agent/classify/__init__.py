"""Deterministic classifier chain (pre-LLM routing).

See `base.Classifier` for the contract and `run_classifier_chain` for the
runner. `router_node` runs the chain first and falls back to the LLM router.
"""

from lectorium_chat.agent.classify.address import AddressClassifier
from lectorium_chat.agent.classify.base import Classifier, run_classifier_chain
from lectorium_chat.agent.classify.lecture_url import LectureUrlClassifier

__all__ = [
    "AddressClassifier",
    "Classifier",
    "LectureUrlClassifier",
    "run_classifier_chain",
]
