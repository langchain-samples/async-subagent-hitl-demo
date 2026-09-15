"""End-to-end proof of direct async-subagent interrupt handling."""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Any

from langgraph_sdk import get_client


AGENT_URL = os.getenv("LANGGRAPH_API_URL", "http://127.0.0.1:2024")
INTERRUPT_TIMEOUT_SECONDS = 20


async def wait_for_status(client: Any, thread_id: str, expected: str) -> dict[str, Any]:
    """Wait for the newest run on a thread to reach the expected status."""
    loop = asyncio.get_running_loop()
    deadline = loop.time() + INTERRUPT_TIMEOUT_SECONDS
    last_status = "not-created"

    while loop.time() < deadline:
        runs = await client.runs.list(thread_id, limit=10)
        if runs:
            newest = runs[0]
            last_status = newest["status"]
            if last_status == expected:
                return newest
            if last_status in {"error", "timeout", "cancelled"}:
                raise RuntimeError(f"Worker entered terminal status {last_status}: {newest}")
        await asyncio.sleep(0.1)

    raise TimeoutError(f"Worker did not reach {expected!r}; last status was {last_status!r}")


async def wait_for_interrupt(client: Any, thread_id: str) -> dict[str, Any]:
    """Wait for a durable interrupt on the worker thread.

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
            raise RuntimeError(f"Worker failed before interrupting: {runs[0]}")
        await asyncio.sleep(0.1)

    raise TimeoutError("Worker did not expose a pending thread interrupt")


async def main() -> None:
    client = get_client(url=AGENT_URL)

    orchestrator_thread = await client.threads.create()
    orchestrator_thread_id = orchestrator_thread["thread_id"]
    print(f"1. Created orchestrator thread: {orchestrator_thread_id}")

    orchestrator_state = await client.runs.wait(
        orchestrator_thread_id,
        "orchestrator",
        input={"messages": [{"role": "user", "content": "Prepare a tiny launch announcement."}]},
    )
    async_tasks = orchestrator_state.get("async_tasks", {})
    if len(async_tasks) != 1:
        raise AssertionError(f"Expected one async task, got: {async_tasks}")

    worker_thread_id, tracked_task = next(iter(async_tasks.items()))
    if worker_thread_id == orchestrator_thread_id:
        raise AssertionError("Worker and orchestrator unexpectedly share a thread")
    print(f"2. Orchestrator returned with worker task: {worker_thread_id}")
    print(f"   Tracked worker run: {tracked_task['run_id']}")

    worker_state = await wait_for_interrupt(client, worker_thread_id)
    interrupts = worker_state.get("interrupts", [])
    if len(interrupts) != 1:
        raise AssertionError(f"Expected one worker interrupt, got: {interrupts}")

    interrupt_value = interrupts[0]["value"]
    action_requests = interrupt_value["action_requests"]
    review_configs = interrupt_value["review_configs"]
    print("3. Worker interrupted independently")
    print(f"   Action: {action_requests[0]['name']}")
    print(f"   Allowed decisions: {review_configs[0]['allowed_decisions']}")

    status_state = await client.runs.wait(
        orchestrator_thread_id,
        "orchestrator",
        input={"messages": [{"role": "user", "content": "Check the worker status."}]},
    )
    status_message = status_state["messages"][-1]["content"]
    if "waiting for approval" not in status_message:
        raise AssertionError(f"Orchestrator did not report the pending interrupt: {status_message}")
    print(f"4. Orchestrator polled the worker checkpoint: {status_message}")

    responsive_state = await client.runs.wait(
        orchestrator_thread_id,
        "orchestrator",
        input={"messages": [{"role": "user", "content": "Are you still responsive?"}]},
    )
    last_message = responsive_state["messages"][-1]
    print(f"5. Orchestrator remained responsive: {last_message['content']}")
    orchestrator_runs_before_resume = await client.runs.list(orchestrator_thread_id, limit=10)

    await client.runs.wait(
        worker_thread_id,
        "worker",
        command={"resume": {"decisions": [{"type": "approve"}]}},
    )
    await wait_for_status(client, worker_thread_id, "success")
    worker_state = await client.threads.get_state(worker_thread_id)
    worker_last_message = worker_state["values"]["messages"][-1]
    print(f"6. Worker resumed directly and completed: {worker_last_message['content']}")

    orchestrator_runs_after_resume = await client.runs.list(orchestrator_thread_id, limit=10)
    if len(orchestrator_runs_after_resume) != len(orchestrator_runs_before_resume):
        raise AssertionError("Direct worker resume unexpectedly created an orchestrator run")

    print("7. Confirmed: direct worker resume did not invoke the orchestrator")
    print("\nPASS: async worker interrupt and direct resume work end to end.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        raise
