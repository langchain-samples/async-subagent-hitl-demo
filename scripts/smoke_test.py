"""End-to-end proof of direct async-subagent interrupt handling."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

from langgraph_sdk import get_client


AGENT_URL = os.getenv("LANGGRAPH_API_URL", "http://127.0.0.1:2024")
INTERRUPT_TIMEOUT_SECONDS = 20


async def wait_for_interrupt(client: Any, thread_id: str) -> dict[str, Any]:
    """Wait for a durable interrupt on the sub-agent thread.

    An interrupt is a successful graph suspension, so the associated run can
    report ``success`` while the thread state carries pending interrupts.
    """
    loop = asyncio.get_running_loop()
    deadline = loop.time() + INTERRUPT_TIMEOUT_SECONDS

    while loop.time() < deadline:
        state = await client.threads.get_state(thread_id)
        if state.get("interrupts"):
            return state

        runs = await client.runs.list(thread_id, limit=1)
        if runs and runs[0]["status"] in {"error", "timeout", "cancelled"}:
            raise RuntimeError(f"Sub-agent failed before interrupting: {runs[0]}")
        await asyncio.sleep(0.1)

    raise TimeoutError("Sub-agent did not expose a pending thread interrupt")


async def main() -> None:
    client = get_client(url=AGENT_URL)

    orchestrator_thread = await client.threads.create()
    orchestrator_thread_id = orchestrator_thread["thread_id"]
    print(f"1. Created orchestrator thread: {orchestrator_thread_id}")

    orchestrator_state = await client.runs.wait(
        orchestrator_thread_id,
        "orchestrator",
        input={
            "messages": [
                {
                    "role": "user",
                    "content": "Prepare the product launch announcement for the company newsroom.",
                }
            ]
        },
    )
    async_tasks = orchestrator_state.get("async_tasks", {})
    if len(async_tasks) != 1:
        raise AssertionError(f"Expected one async task, got: {async_tasks}")

    worker_thread_id, tracked_task = next(iter(async_tasks.items()))
    if worker_thread_id == orchestrator_thread_id:
        raise AssertionError("Sub-agent and orchestrator unexpectedly share a thread")
    print(f"2. Orchestrator returned with sub-agent task: {worker_thread_id}")
    print(f"   Tracked sub-agent run: {tracked_task['run_id']}")

    worker_state = await wait_for_interrupt(client, worker_thread_id)
    interrupts = worker_state.get("interrupts", [])
    if len(interrupts) != 1:
        raise AssertionError(f"Expected one sub-agent interrupt, got: {interrupts}")

    interrupt_value = interrupts[0]["value"]
    action_requests = interrupt_value["action_requests"]
    review_configs = interrupt_value["review_configs"]
    if action_requests[0]["name"] != "publish_announcement":
        raise AssertionError(f"Expected publish approval, got: {action_requests}")
    print("3. Announcement writer interrupted independently")
    print(f"   Action: {action_requests[0]['name']}")
    print(f"   Allowed decisions: {review_configs[0]['allowed_decisions']}")

    responsive_state = await client.runs.wait(
        orchestrator_thread_id,
        "orchestrator",
        input={"messages": [{"role": "user", "content": "Are you still responsive?"}]},
    )
    last_message = responsive_state["messages"][-1]
    print(f"4. Orchestrator remained responsive: {last_message['content']}")
    orchestrator_runs_before_resume = await client.runs.list(orchestrator_thread_id, limit=10)

    worker_values = await client.runs.wait(
        worker_thread_id,
        "worker",
        command={"resume": {"decisions": [{"type": "approve"}]}},
    )
    worker_last_message = worker_values["messages"][-1]
    print(f"5. Announcement writer resumed directly and completed: {worker_last_message['content']}")

    orchestrator_runs_after_resume = await client.runs.list(orchestrator_thread_id, limit=10)
    if len(orchestrator_runs_after_resume) != len(orchestrator_runs_before_resume):
        raise AssertionError("Direct sub-agent resume unexpectedly created an orchestrator run")

    print("6. Confirmed: direct sub-agent resume did not invoke the orchestrator")
    print("\nPASS: async sub-agent interrupt and direct resume work end to end.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise
