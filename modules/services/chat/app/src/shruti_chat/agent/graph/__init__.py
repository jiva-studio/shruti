"""LangGraph integration layer — adapters between our domain/application
types (ToolDef, LLMPort, Message) and LangGraph's StateGraph / Runnable
machinery.

Files here may import langgraph / langchain_core. Files OUTSIDE this
package must not — see hexagonal layering in plan section 1.7.
"""

from shruti_chat.agent.graph.builder import build_chat_graph
from shruti_chat.agent.graph.state import ChatState
from shruti_chat.agent.graph.tool_adapter import as_langchain_tool

__all__ = ["as_langchain_tool", "build_chat_graph", "ChatState"]
