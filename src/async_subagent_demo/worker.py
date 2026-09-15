"""Independent Deep Agents worker graph with built-in HITL review."""

from deepagents import create_deep_agent
from langchain.tools import tool

from async_subagent_demo.mock_models import DemoChatModel


@tool
def finalize_task(task_name: str, result: str) -> str:
    """Finalize a mocked task result after human review."""
    return f"Finalized {task_name}: {result}"


graph = create_deep_agent(
    model=DemoChatModel(role="worker"),
    name="worker",
    system_prompt="Complete the requested mock work, then call finalize_task exactly once.",
    tools=[finalize_task],
    interrupt_on={"finalize_task": True},
)
