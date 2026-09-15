# Async sub-agent interrupt demo

This demo shows that an asynchronous Deep Agents sub-agent does not need to bubble its human-in-the-loop interrupt through the orchestrator. Because the orchestrator and sub-agent run as independent LangGraph threads, the application UI can surface the sub-agent's interrupt and resume it directly while the orchestrator remains available for other work.

## Architecture

- `orchestrator`: a Deep Agent configured with one `AsyncSubAgent` named `worker`.
- `worker`: a Deep Agent with a mocked `finalize_task` tool protected by `interrupt_on=True`.
- Local Agent Server: runs both graphs and owns thread state, checkpoints, and interrupts.
- React UI: uses the official `@langchain/react` stream hooks for the orchestrator and worker threads, surfaces the built-in HITL decisions, and resumes the worker directly.
- Smoke-test client: provides a headless end-to-end check of the same workflow.

The orchestrator thread owns the conversation and `async_tasks` correlation
metadata. The worker thread independently owns its messages, checkpoints, and
interrupt payload. The Agent Server is authoritative; the UI only observes
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
uv run langgraph dev
```

In another terminal, start the UI:

```bash
pnpm --dir frontend dev
```

Open [http://127.0.0.1:5173](http://127.0.0.1:5173), send the pre-filled message, and review the worker request in the right-hand panel. While the approval is pending, the orchestrator chat remains usable. The available buttons come from the worker interrupt's `allowed_decisions` field (`approve`, `edit`, `reject`, and `respond`).

Use **Poll worker status** to send a new turn to the orchestrator. Its
checkpoint-aware `check_worker_status` tool reads the independent worker
thread and reports `waiting_for_approval` plus the pending action. This is an
explicit agent poll, separate from the UI's lightweight checkpoint polling.

To run the headless end-to-end check instead:

```bash
uv run python scripts/smoke_test.py
```

Both paths demonstrate that:

1. The orchestrator launches the worker and returns immediately.
2. The worker pauses at the HITL middleware before `finalize_task` executes.
3. The client reads the built-in action and review configuration.
4. The orchestrator can explicitly poll the worker and see its pending approval.
5. The client resumes the worker thread directly with an approval decision.
6. The worker completes without a resume invocation on the orchestrator thread.

The durable HITL signal is the worker thread's pending `interrupts` value. The
associated run may be recorded as successful because reaching an interrupt is
a successful graph suspension rather than an execution error.

Because the async worker is an independent thread, the UI briefly polls that
thread's checkpoint until the interrupt is durable, then hydrates its worker
stream. The decision is sent directly to the `worker` assistant with LangGraph's
standard `Command(resume=...)` payload; the orchestrator is not involved.

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
