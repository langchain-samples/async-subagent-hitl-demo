"""Independent announcement-writer graph with built-in HITL review."""

from deepagents import create_deep_agent
from langchain.tools import tool

from async_subagent_demo.mock_models import DemoChatModel


@tool
def publish_announcement(channel: str, headline: str, body: str) -> str:
    """Publish an approved company announcement to a named channel."""
    return f'Published “{headline}” to {channel}: {body}'


graph = create_deep_agent(
    model=DemoChatModel(role="worker"),
    name="worker",
    system_prompt=(
        "You write product announcements for a company. Draft the requested "
        "announcement, then call publish_announcement exactly once."
    ),
    tools=[publish_announcement],
    interrupt_on={"publish_announcement": True},
)
