"""Deep Agents launch-coordinator graph."""

from deepagents import AsyncSubAgent, create_deep_agent

from async_subagent_demo.mock_models import DemoChatModel

graph = create_deep_agent(
    model=DemoChatModel(role="orchestrator"),
    name="orchestrator",
    system_prompt=(
        "You coordinate product launches for a company. Delegate launch "
        "communications to the announcement writer and remain available."
    ),
    subagents=[
        AsyncSubAgent(
            name="worker",
            description=(
                "Drafts product announcements and proposes publishing them to a "
                "communications channel for human approval."
            ),
            graph_id="worker",
        )
    ],
)
