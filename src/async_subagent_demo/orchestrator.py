"""Deep Agents orchestrator graph."""

import json
from typing import Any

from deepagents import AsyncSubAgent, create_deep_agent
from langchain.tools import tool
from langgraph_sdk import get_client

from async_subagent_demo.mock_models import DemoChatModel


def _interrupt_summary(interrupt: dict[str, Any]) -> tuple[str | None, list[str]]:
    """Extract the pending action and allowed decisions from a HITL interrupt."""
    value = interrupt.get("value") or {}
    actions = value.get("action_requests") or []
    configs = value.get("review_configs") or []
    action_name = actions[0].get("name") if actions else None
    allowed = configs[0].get("allowed_decisions", []) if configs else []
    return action_name, allowed


@tool
async def check_worker_status(task_id: str) -> str:
    """Check a worker thread's live checkpoint, including pending human review."""
    client = get_client(url=None)
    state = await client.threads.get_state(thread_id=task_id)
    interrupts = state.get("interrupts") or []

    if interrupts:
        action_name, allowed = _interrupt_summary(interrupts[0])
        return json.dumps(
            {
                "task_id": task_id,
                "status": "waiting_for_approval",
                "pending_action": action_name,
                "allowed_decisions": allowed,
            }
        )

    runs = await client.runs.list(thread_id=task_id, limit=1)
    status = runs[0]["status"] if runs else "not_started"
    return json.dumps({"task_id": task_id, "status": status})


graph = create_deep_agent(
    model=DemoChatModel(role="orchestrator"),
    name="orchestrator",
    system_prompt=(
        "Launch the worker with start_async_task for work that needs review. "
        "After launching, report that it is running and return control immediately. "
        "Never check the task immediately after launch. When the user requests "
        "a status update, call check_worker_status with the tracked task ID."
    ),
    tools=[check_worker_status],
    subagents=[
        AsyncSubAgent(
            name="worker",
            description="Performs a mocked task and submits its result for human review.",
            graph_id="worker",
        )
    ],
)
