"""Deterministic tool-calling models for the local demo.

Only model choices are mocked. Deep Agents and LangGraph still execute their
real middleware, tools, checkpoints, threads, runs, interrupts, and resumes.
"""

import json
from collections.abc import Sequence
from typing import Any, Literal

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.runnables import Runnable
from langchain_core.tools import BaseTool


class DemoChatModel(BaseChatModel):
    """A deterministic chat model that makes the demo reproducible."""

    role: Literal["orchestrator", "worker"]

    @property
    def _llm_type(self) -> str:
        return f"async-subagent-demo-{self.role}"

    @property
    def _identifying_params(self) -> dict[str, Any]:
        return {"role": self.role}

    def bind_tools(
        self,
        tools: Sequence[BaseTool | dict[str, Any] | type | Any],
        *,
        tool_choice: str | None = None,
        **kwargs: Any,
    ) -> Runnable[Any, AIMessage]:
        """Accept the tool set while keeping deterministic response logic."""
        del tools, tool_choice, kwargs
        return self

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        del stop, run_manager, kwargs
        message = self._orchestrator_response(messages) if self.role == "orchestrator" else self._worker_response(messages)
        return ChatResult(generations=[ChatGeneration(message=message)])

    @staticmethod
    def _orchestrator_response(messages: list[BaseMessage]) -> AIMessage:
        launch_result = next(
            (
                message
                for message in messages
                if isinstance(message, ToolMessage) and "Launched async subagent" in str(message.content)
            ),
            None,
        )
        launched = launch_result is not None
        human_turns = sum(isinstance(message, HumanMessage) for message in messages)

        if not launched and human_turns == 1:
            return AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "start_async_task",
                        "args": {
                            "description": (
                                "Draft a one-sentence launch announcement, then call finalize_task "
                                "with the draft so a human can review it."
                            ),
                            "subagent_type": "worker",
                        },
                        "id": "launch-worker-1",
                        "type": "tool_call",
                    }
                ],
            )

        last_human_index = next(
            (index for index in range(len(messages) - 1, -1, -1) if isinstance(messages[index], HumanMessage)),
            -1,
        )
        last_human = messages[last_human_index] if last_human_index >= 0 else None
        status_requested = isinstance(last_human, HumanMessage) and any(
            word in str(last_human.content).lower() for word in ("check", "status", "poll")
        )

        if status_requested and launch_result is not None:
            tool_call_id = f"check-worker-status-{human_turns}"
            status_result = next(
                (
                    message
                    for message in messages[last_human_index + 1 :]
                    if isinstance(message, ToolMessage) and message.tool_call_id == tool_call_id
                ),
                None,
            )
            if status_result is None:
                task_id = str(launch_result.content).split("task_id:", 1)[1].strip().split()[0]
                return AIMessage(
                    content="",
                    tool_calls=[
                        {
                            "name": "check_worker_status",
                            "args": {"task_id": task_id},
                            "id": tool_call_id,
                            "type": "tool_call",
                        }
                    ],
                )

            result = json.loads(str(status_result.content))
            if result["status"] == "waiting_for_approval":
                return AIMessage(
                    content=(
                        "I checked the worker directly. Status: waiting for approval. "
                        f"Pending action: {result.get('pending_action') or 'unknown'}."
                    )
                )
            return AIMessage(content=f"I checked the worker directly. Status: {result['status']}.")

        if human_turns > 1:
            return AIMessage(content="Yes. I remain responsive while the worker is waiting for human review.")

        return AIMessage(content="The worker is running in the background. I can continue helping while it works.")

    @staticmethod
    def _worker_response(messages: list[BaseMessage]) -> AIMessage:
        tool_result = next(
            (
                message
                for message in reversed(messages)
                if isinstance(message, ToolMessage) and message.tool_call_id == "finalize-task-1"
            ),
            None,
        )
        if tool_result is not None:
            return AIMessage(content=f"Worker finished after review. Tool result: {tool_result.content}")

        return AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "finalize_task",
                    "args": {
                        "task_name": "launch announcement",
                        "result": "The demo launches a delightfully small async-agent workflow.",
                    },
                    "id": "finalize-task-1",
                    "type": "tool_call",
                }
            ],
        )
