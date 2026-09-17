# Async sub-agent interrupt demo

This demo shows that an asynchronous Deep Agents sub-agent does not need to bubble its human-in-the-loop interrupt through the orchestrator. Because the orchestrator and sub-agent run as independent LangGraph threads, the application UI can surface the sub-agent's interrupt and resume it directly while the orchestrator remains available for other work.

## Architecture

- `orchestrator`: a launch coordinator configured with one `AsyncSubAgent` announcement writer.
- `worker`: an announcement writer with a mocked `publish_announcement` tool protected by `interrupt_on=True`.
- Local Agent Server: runs both graphs and owns thread state, checkpoints, and interrupts.
- React UI: uses the official `@langchain/react` stream hooks for the orchestrator and sub-agent threads, surfaces the built-in HITL decisions, and resumes the sub-agent directly.
- Smoke-test client: provides a headless end-to-end check of the same workflow.

The orchestrator thread owns the conversation and `async_tasks` correlation
metadata. The sub-agent thread independently owns its messages, checkpoints,
and interrupt payload. The Agent Server is authoritative; the UI only observes
state and submits decisions.

## Prerequisites

- Python 3.11+
- `uv`
- Node.js 20.19+
- `pnpm`

No model API key is required. The demo uses deterministic local chat-model stubs while retaining the real Deep Agents, LangGraph, Agent Server, async-subagent, and HITL middleware behavior.

## Setup

```bash
uv sync
pnpm --dir frontend install
```

## Run

Start the local Agent Server:

```bash
uv run langgraph dev --n-jobs-per-worker 3
```

In another terminal, start the UI:

```bash
pnpm --dir frontend dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173) and ask the launch coordinator to prepare a product announcement. The end-user view shows read-only sub-agent status. When approval is required, open the linked approver view in a separate tab; that route displays the decisions from the sub-agent interrupt's `allowed_decisions` field (`approve`, `edit`, `reject`, and `respond`). While approval is pending, the launch coordinator remains usable.

The side-task panel polls `threads.getState(worker_thread_id)` every 1.5
seconds. It projects the durable checkpoint into a small application status
(`drafting`, `approval_required`, `applying_decision`, `complete`, or `error`)
instead of exposing raw graph internals. The sidebar—not the orchestrator
conversation—is responsible for showing the end user that review is pending.
The separate approver route surfaces the interrupt and submits the decision.
Both views observe the same sub-agent thread, so the end-user status updates
after the approver resumes it.

To run the headless end-to-end check instead:

```bash
uv run python scripts/smoke_test.py
```

Both paths demonstrate that:

1. The launch coordinator starts the announcement writer and returns immediately.
2. The writer pauses before `publish_announcement` executes.
3. The application UI reads the built-in action and review configuration.
4. The launch coordinator remains responsive while publication approval is pending.
5. The application UI resumes the writer thread directly with a decision.
6. The writer completes without a resume invocation on the orchestrator thread.

The durable HITL signal is the worker thread's pending `interrupts` value. The
associated run may be recorded as successful because reaching an interrupt is
a successful graph suspension rather than an execution error.

Because the async sub-agent is an independent thread, the UI polls that
thread's checkpoint for durable status and hydrates its message stream. The
decision is sent directly to the `worker` assistant with LangGraph's standard
`Command(resume=...)` payload; the orchestrator is not involved.

## Project layout

```text
.
├── langgraph.json
├── pyproject.toml
├── frontend/
│   ├── package.json
│   ├── pnpm-lock.yaml
│   └── src/
│       ├── App.tsx
│       ├── main.tsx
│       └── styles.css
├── scripts/smoke_test.py
└── src/async_subagent_demo/
    ├── mock_models.py
    ├── orchestrator.py
    └── worker.py
```
