import { FormEvent, useEffect, useMemo, useState } from "react";
import { useStream } from "@langchain/react";
import type { BaseMessage } from "@langchain/core/messages";

const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL ?? "http://127.0.0.1:2024";

type AsyncTask = {
  run_id?: string;
  status?: string;
};

type AgentState = {
  messages?: unknown[];
  async_tasks?: Record<string, AsyncTask>;
};

type ActionRequest = {
  name: string;
  args: Record<string, unknown>;
  description?: string;
};

type ReviewConfig = {
  action_name: string;
  allowed_decisions: Array<"approve" | "edit" | "reject" | "respond">;
};

type HitlInterrupt = {
  action_requests: ActionRequest[];
  review_configs: ReviewConfig[];
};

type DecisionType = ReviewConfig["allowed_decisions"][number];

function shortId(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "created on first message";
}

function errorText(error: unknown) {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function MessageBubble({ message }: { message: BaseMessage }) {
  const role = message.type;
  if (role !== "human" && role !== "ai") return null;
  const text = message.text.trim();
  if (!text) return null;

  return (
    <article className={`message message--${role}`}>
      <span className="message__role">{role === "human" ? "You" : "Orchestrator"}</span>
      <p>{text}</p>
    </article>
  );
}

function WorkerPanel({ threadId, task }: { threadId: string; task?: AsyncTask }) {
  const worker = useStream<AgentState, HitlInterrupt>({
    assistantId: "worker",
    apiUrl: API_URL,
    threadId,
  });
  const [checkpointInterrupt, setCheckpointInterrupt] = useState<HitlInterrupt | null>(null);
  const interrupt = worker.interrupt?.value ?? checkpointInterrupt;
  const action = interrupt?.action_requests?.[0];
  const reviewConfig = interrupt?.review_configs?.[0];
  const allowed = reviewConfig?.allowed_decisions ?? [];
  const [reviewNote, setReviewNote] = useState("");
  const [editedArgs, setEditedArgs] = useState("");
  const [decision, setDecision] = useState<DecisionType | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [isDirectResuming, setIsDirectResuming] = useState(false);
  const [completed, setCompleted] = useState(false);

  const argsText = useMemo(
    () => JSON.stringify(action?.args ?? {}, null, 2),
    [action?.args],
  );

  useEffect(() => {
    if (interrupt || decision !== null) return;
    let cancelled = false;

    const checkCheckpoint = async () => {
      try {
        const state = await worker.client.threads.getState(threadId);
        const interrupts = (state as { interrupts?: Array<{ value?: HitlInterrupt }> }).interrupts;
        const value = interrupts?.[0]?.value;
        if (!cancelled && value) setCheckpointInterrupt(value);
      } catch {
        // A transient poll failure is surfaced by the stream if hydration fails.
      }
    };

    void checkCheckpoint();
    const poll = window.setInterval(() => void checkCheckpoint(), 300);
    return () => {
      cancelled = true;
      window.clearInterval(poll);
    };
  }, [decision, interrupt, threadId, worker.client]);

  const submitDecision = async (type: DecisionType) => {
    if (!action) return;
    setDecisionError(null);

    let payload: Record<string, unknown> = { type };
    if (type === "reject" || type === "respond") {
      payload = {
        type,
        message:
          reviewNote.trim() ||
          (type === "reject" ? "Rejected in the demo review UI." : "Please revise and resubmit."),
      };
    }
    if (type === "edit") {
      try {
        payload = {
          type,
          edited_action: {
            name: action.name,
            args: JSON.parse(editedArgs || argsText),
          },
        };
      } catch {
        setDecisionError("Edited arguments must be valid JSON.");
        return;
      }
    }

    try {
      setDecision(type);
      setIsDirectResuming(true);
      await worker.client.runs.wait(threadId, "worker", {
        command: { resume: { decisions: [payload] } },
      });
      setCompleted(true);
    } catch (error) {
      setDecision(null);
      setDecisionError(errorText(error));
    } finally {
      setIsDirectResuming(false);
    }
  };

  const workerComplete = completed;

  return (
    <section className="panel panel--worker" aria-labelledby="worker-heading">
      <header className="panel__header">
        <div>
          <span className="eyebrow">Independent graph</span>
          <h2 id="worker-heading">Async worker</h2>
        </div>
        <span className={`status-dot ${interrupt && decision === null ? "status-dot--attention" : "status-dot--active"}`}>
          {workerComplete ? "Complete" : interrupt && decision === null ? "Review needed" : "Running"}
        </span>
      </header>

      <div className="thread-meta">
        <span>Worker thread</span>
        <code title={threadId}>{shortId(threadId)}</code>
      </div>

      <ol className="progress-list">
        <li className="progress-list__done">
          <span>1</span>
          <div><strong>Worker launched</strong><small>Run {shortId(task?.run_id ?? null)}</small></div>
        </li>
        <li className={interrupt && decision === null ? "progress-list__current" : decision ? "progress-list__done" : ""}>
          <span>2</span>
          <div><strong>Human review</strong><small>{workerComplete ? `${decision} applied` : interrupt && decision === null ? "Waiting for your decision" : decision ? `${decision} submitted` : "Preparing result"}</small></div>
        </li>
        <li className={workerComplete ? "progress-list__done" : ""}>
          <span>3</span>
          <div><strong>Direct resume</strong><small>{workerComplete ? "Worker completed independently" : "No orchestrator hop"}</small></div>
        </li>
      </ol>

      {worker.isThreadLoading && <div className="loading-card">Loading worker state…</div>}

      {interrupt && action && decision === null && (
        <div className="approval-card">
          <div className="approval-card__topline">
            <span className="approval-icon" aria-hidden="true">!</span>
            <div>
              <span className="eyebrow">Tool approval</span>
              <h3>{action.name}</h3>
            </div>
          </div>
          {action.description && <p className="approval-description">{action.description}</p>}

          <div className="field-label">Proposed arguments</div>
          <textarea
            className="code-editor"
            aria-label="Proposed tool arguments"
            value={editedArgs || argsText}
            onChange={(event) => setEditedArgs(event.target.value)}
            spellCheck={false}
          />

          {(allowed.includes("reject") || allowed.includes("respond")) && (
            <label className="review-note">
              <span>Reviewer note <em>optional</em></span>
              <input
                value={reviewNote}
                onChange={(event) => setReviewNote(event.target.value)}
                placeholder="Reason or instructions for the worker"
              />
            </label>
          )}

          {decisionError && <p className="error-banner">{decisionError}</p>}
          <div className="decision-row">
            {allowed.map((type) => (
              <button
                className={`decision decision--${type}`}
                disabled={worker.isLoading || decision !== null}
                key={type}
                onClick={() => void submitDecision(type)}
                type="button"
              >
                {type === "approve" ? "Approve" : type === "edit" ? "Approve edit" : type === "reject" ? "Reject" : "Respond"}
              </button>
            ))}
          </div>
          <p className="direct-note">Decision resumes this worker thread directly.</p>
        </div>
      )}

      {isDirectResuming && decision && (
        <div className="loading-card"><span className="spinner" /> Resuming worker with “{decision}”…</div>
      )}

      {workerComplete && (
        <div className="complete-card">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>Worker finished</strong>
            <p>{worker.messages.filter((message) => message.type === "ai" && message.text.trim()).at(-1)?.text ?? "The reviewed action completed."}</p>
          </div>
        </div>
      )}

      {(errorText(worker.error) || decisionError) && !interrupt && (
        <p className="error-banner">{errorText(worker.error) ?? decisionError}</p>
      )}
    </section>
  );
}

function EmptyWorkerPanel() {
  return (
    <section className="panel panel--worker panel--empty" aria-labelledby="worker-heading">
      <header className="panel__header">
        <div>
          <span className="eyebrow">Independent graph</span>
          <h2 id="worker-heading">Async worker</h2>
        </div>
        <span className="status-dot">Not started</span>
      </header>
      <div className="empty-state">
        <div className="empty-state__glyph" aria-hidden="true">↗</div>
        <h3>No background job yet</h3>
        <p>Send the first message. The orchestrator will launch one worker and return immediately.</p>
      </div>
    </section>
  );
}

function DemoSession({ onReset }: { onReset: () => void }) {
  const orchestrator = useStream<AgentState>({
    assistantId: "orchestrator",
    apiUrl: API_URL,
  });
  const [input, setInput] = useState("Prepare a tiny launch announcement.");
  const tasks = Object.entries(orchestrator.values.async_tasks ?? {});
  const [workerThreadId, workerTask] = tasks[0] ?? [];

  const sendMessage = async (content: string) => {
    if (!content || orchestrator.isLoading) return;
    await orchestrator.submit({ messages: [{ role: "user", content }] });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const content = input.trim();
    if (!content || orchestrator.isLoading) return;
    setInput("");
    await sendMessage(content);
  };

  return (
    <>
      <header className="app-header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true"><span /><span /></div>
          <div>
            <span className="eyebrow">Async sub-agent demo</span>
            <h1>Async review desk</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className="server-status"><i /> Local Agent Server</span>
          <button className="reset-button" type="button" onClick={onReset}>New demo</button>
        </div>
      </header>

      <main className="workspace">
        <section className="panel panel--chat" aria-labelledby="orchestrator-heading">
          <header className="panel__header">
            <div>
              <span className="eyebrow">Primary graph</span>
              <h2 id="orchestrator-heading">Orchestrator</h2>
            </div>
            <span className={`status-dot ${orchestrator.isLoading ? "status-dot--active" : ""}`}>
              {orchestrator.isLoading ? "Working" : "Available"}
            </span>
          </header>

          <div className="thread-meta">
            <span>Conversation thread</span>
            <code title={orchestrator.threadId ?? undefined}>{shortId(orchestrator.threadId)}</code>
          </div>

          <div className="messages" aria-live="polite">
            {orchestrator.messages.length === 0 && (
              <div className="chat-intro">
                <span>01</span>
                <h3>Start the work</h3>
                <p>The first message creates an orchestrator thread and dispatches a mocked long-running worker.</p>
              </div>
            )}
            {orchestrator.messages.map((message, index) => (
              <MessageBubble key={message.id ?? index} message={message} />
            ))}
            {orchestrator.isLoading && <div className="typing"><i /><i /><i /></div>}
          </div>

          {errorText(orchestrator.error) && <p className="error-banner">{errorText(orchestrator.error)}</p>}

          <form className="composer" onSubmit={(event) => void submit(event)}>
            <label htmlFor="chat-input">Message orchestrator</label>
            <div>
              <input
                id="chat-input"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Ask the orchestrator something…"
              />
              <button disabled={!input.trim() || orchestrator.isLoading} type="submit">
                Send <span aria-hidden="true">↑</span>
              </button>
            </div>
          </form>
          {workerThreadId && (
            <div className="responsive-hint">
              <span>The orchestrator remains available while the worker waits.</span>
              <button
                disabled={orchestrator.isLoading}
                onClick={() => void sendMessage("Check the worker status.")}
                type="button"
              >
                Poll worker status
              </button>
            </div>
          )}
        </section>

        {workerThreadId ? (
          <WorkerPanel key={workerThreadId} threadId={workerThreadId} task={workerTask} />
        ) : (
          <EmptyWorkerPanel />
        )}
      </main>

      <footer className="app-footer">
        <span>Two threads · two independent graphs</span>
        <span>Interrupt state is read from the worker checkpoint</span>
      </footer>
    </>
  );
}

export function App() {
  const [session, setSession] = useState(0);
  return <DemoSession key={session} onReset={() => setSession((value) => value + 1)} />;
}
