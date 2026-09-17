"""Deterministic tool-calling models for the local demo.

Only model choices are mocked. Deep Agents and LangGraph still execute their
real middleware, tools, checkpoints, threads, runs, interrupts, and resumes.
"""

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
                                "Draft a product-launch announcement, then call "
                                "publish_announcement for the company newsroom so a "
                                "communications lead can review it."
                            ),
                            "subagent_type": "worker",
                        },
                        "id": "launch-worker-1",
                        "type": "tool_call",
                    }
                ],
            )

        if human_turns > 1:
            return AIMessage(
                content=(
                    "Yes—I can keep coordinating the launch while the announcement writer "
                    "waits for the communications lead's approval."
                )
            )

        return AIMessage(
            content=(
                "The announcement writer is drafting the launch post in the background. "
                "I can continue coordinating the launch while it works."
            )
        )

    @staticmethod
    def _worker_response(messages: list[BaseMessage]) -> AIMessage:
        tool_result = next(
            (
                message
                for message in reversed(messages)
                if isinstance(message, ToolMessage) and message.tool_call_id == "publish-announcement-1"
            ),
            None,
        )
        if tool_result is not None:
            return AIMessage(content=f"Announcement published after approval. {tool_result.content}")

        return AIMessage(
            content="",
            tool_calls=[
                {
                    "name": "publish_announcement",
                    "args": {
                        "channel": "Company newsroom",
                        "headline": "Product launch announcement",
                        "body": "We are announcing the launch of our latest product today.",
                    },
                    "id": "publish-announcement-1",
                    "type": "tool_call",
                }
            ],
        )
