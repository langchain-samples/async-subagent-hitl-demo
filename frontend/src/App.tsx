import { FormEvent, useEffect, useMemo, useState } from "react";
import { useStream } from "@langchain/react";
import type { BaseMessage } from "@langchain/core/messages";

const API_URL = import.meta.env.VITE_LANGGRAPH_API_URL ?? "http://127.0.0.1:2024";

type AgentState = {
  messages?: unknown[];
  async_tasks?: Record<string, unknown>;
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

type WorkerPhase =
  | "drafting"
  | "approval_required"
  | "applying_decision"
  | "complete"
  | "error";

type WorkerStateSnapshot = {
  values?: AgentState;
  interrupts?: Array<{ value?: HitlInterrupt }>;
  tasks?: Array<{
    error?: string | null;
    interrupts?: Array<{ value?: HitlInterrupt }>;
  }>;
};

const CHECKPOINT_POLL_MS = 1_500;

const STATUS_LABELS: Record<WorkerPhase, string> = {
  drafting: "Drafting",
  approval_required: "Approval required",
  applying_decision: "Applying decision",
  complete: "Complete",
  error: "Error",
};

const STATUS_DETAILS: Record<WorkerPhase, string> = {
  drafting: "The announcement writer is preparing a draft.",
  approval_required: "The draft is waiting for publication approval.",
  applying_decision: "The decision is being applied to the announcement.",
  complete: "The publication review is complete.",
  error: "The announcement writer could not complete its task.",
};

function shortId(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-4)}` : "created on first message";
}

function errorText(error: unknown) {
  if (!error) return null;
  return error instanceof Error ? error.message : String(error);
}

function interruptFromState(state: WorkerStateSnapshot) {
  const directInterrupt = state.interrupts?.[0]?.value;
  if (directInterrupt) return directInterrupt;

  for (const task of state.tasks ?? []) {
    const taskInterrupt = task.interrupts?.[0]?.value;
    if (taskInterrupt) return taskInterrupt;
  }
  return null;
}

function latestAssistantText(messages: unknown[] | undefined) {
  for (const candidate of [...(messages ?? [])].reverse()) {
    if (!candidate || typeof candidate !== "object") continue;
    const message = candidate as {
      type?: string;
      role?: string;
      content?: unknown;
      text?: string;
    };
    if (message.type !== "ai" && message.role !== "assistant") continue;
    if (typeof message.text === "string" && message.text.trim()) return message.text;
    if (typeof message.content === "string" && message.content.trim()) return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((block) =>
          block && typeof block === "object" && "text" in block
            ? String((block as { text: unknown }).text)
            : "",
        )
        .filter(Boolean)
        .join("\n");
      if (text) return text;
    }
  }
  return null;
}

function MessageBubble({ message }: { message: BaseMessage }) {
  const role = message.type;
  if (role !== "human" && role !== "ai") return null;
  const text = message.text.trim();
  if (!text) return null;

  return (
    <article className={`message message--${role}`}>
      <span className="message__role">{role === "human" ? "You" : "Launch coordinator"}</span>
      <p>{text}</p>
    </article>
  );
}

function SubagentPanel({
  threadId,
  mode,
}: {
  threadId: string;
  mode: "status" | "approval";
}) {
  const worker = useStream<AgentState, HitlInterrupt>({
    assistantId: "worker",
    apiUrl: API_URL,
    threadId,
  });
  const [checkpointInterrupt, setCheckpointInterrupt] = useState<HitlInterrupt | null>(null);
  const [phase, setPhase] = useState<WorkerPhase>("drafting");
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [resultText, setResultText] = useState<string | null>(null);
  const [reviewNote, setReviewNote] = useState("");
  const [editedArgs, setEditedArgs] = useState("");
  const [decision, setDecision] = useState<DecisionType | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const interrupt = checkpointInterrupt;
  const action = interrupt?.action_requests?.[0];
  const reviewConfig = interrupt?.review_configs?.[0];
  const allowed = reviewConfig?.allowed_decisions ?? [];

  const argsText = useMemo(
    () => JSON.stringify(action?.args ?? {}, null, 2),
    [action?.args],
  );

  useEffect(() => {
    let stopped = false;
    let poll: number | undefined;

    const readCheckpoint = async () => {
      try {
        const state = (await worker.client.threads.getState(threadId)) as WorkerStateSnapshot;
        if (stopped) return;
        setPhaseError(null);

        const taskError = state.tasks?.find((task) => task.error)?.error;
        if (taskError) {
          setPhaseError(taskError);
          setPhase("error");
          if (poll) window.clearInterval(poll);
          return;
        }

        const pendingInterrupt = interruptFromState(state);
        if (pendingInterrupt) {
          setCheckpointInterrupt((current) => current ?? pendingInterrupt);
          setPhase((current) =>
            current === "applying_decision" ? current : "approval_required",
          );
          return;
        }

        const finalText = latestAssistantText(state.values?.messages);
        if (finalText) {
          setCheckpointInterrupt(null);
          setResultText(finalText);
          setPhase("complete");
          if (poll) window.clearInterval(poll);
          return;
        }

        setPhase("drafting");
      } catch (error) {
        if (stopped) return;
        setPhaseError(errorText(error));
        setPhase("error");
      }
    };

    void readCheckpoint();
    poll = window.setInterval(() => void readCheckpoint(), CHECKPOINT_POLL_MS);
    return () => {
      stopped = true;
      if (poll) window.clearInterval(poll);
    };
  }, [threadId, worker.client]);

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
      setPhase("applying_decision");
      const values = await worker.client.runs.wait(threadId, "worker", {
        command: { resume: { decisions: [payload] } },
      });
      setResultText(latestAssistantText((values as AgentState).messages));
      setCheckpointInterrupt(null);
      setPhase("complete");
    } catch (error) {
      setDecision(null);
      setDecisionError(errorText(error));
      setPhase("error");
    }
  };

  const workerComplete = phase === "complete";
  const statusClass =
    phase === "approval_required"
      ? "status-dot--attention"
      : phase === "error"
        ? "status-dot--error"
        : phase === "drafting" || phase === "applying_decision"
          ? "status-dot--active"
          : "";
  const completionTitle =
    decision === "reject"
      ? "Publication rejected"
      : decision === "respond"
        ? "Feedback sent"
        : "Announcement published";

  return (
    <section className="panel panel--worker" aria-labelledby="worker-heading">
      <header className="panel__header">
        <div>
          <span className="eyebrow">{mode === "approval" ? "Human approval" : "Async subagent"}</span>
          <h2 id="worker-heading">{mode === "approval" ? "Announcement review" : "Announcement writer"}</h2>
        </div>
        <span className={`status-dot ${statusClass}`}>
          {STATUS_LABELS[phase]}
        </span>
      </header>

      <div className="thread-meta">
        <span>Announcement thread</span>
        <code title={threadId}>{shortId(threadId)}</code>
      </div>

      <div className="status-view" aria-live="polite">
        <div className="status-view__summary">
          <span className="eyebrow">Announcement status</span>
          <strong>{STATUS_LABELS[phase]}</strong>
          <p>{STATUS_DETAILS[phase]}</p>
          <small>Synced from the independent sub-agent checkpoint.</small>
        </div>
      </div>

      <ol className="progress-list">
        <li className="progress-list__done">
          <span>1</span>
          <div><strong>Writer assigned</strong><small>Independent thread started</small></div>
        </li>
        <li className={interrupt && decision === null ? "progress-list__current" : decision ? "progress-list__done" : ""}>
          <span>2</span>
          <div><strong>Editorial review</strong><small>{workerComplete ? `${decision} applied` : interrupt && decision === null ? "Approval required" : decision ? `${decision} submitted` : "Drafting announcement"}</small></div>
        </li>
        <li className={workerComplete ? "progress-list__done" : ""}>
          <span>3</span>
          <div><strong>Outcome</strong><small>{workerComplete ? completionTitle : "Resumes writer directly"}</small></div>
        </li>
      </ol>

      {worker.isThreadLoading && <div className="loading-card">Loading announcement state…</div>}

      {mode === "status" && interrupt && (
        <div className="review-handoff">
          <div>
            <strong>Review assigned to an approver</strong>
            <p>The announcement will continue after a decision is submitted in the approval workspace.</p>
          </div>
          <a
            href={`/approvals/${encodeURIComponent(threadId)}`}
            rel="noreferrer"
            target="_blank"
          >
            Open demo approver view <span aria-hidden="true">↗</span>
          </a>
        </div>
      )}

      {mode === "approval" && interrupt && action && decision === null && (
        <div className="approval-card">
          <div className="approval-card__topline">
            <span className="approval-icon" aria-hidden="true">!</span>
            <div>
              <span className="eyebrow">Publication approval</span>
              <h3>{action.args.headline ? String(action.args.headline) : action.name}</h3>
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
                placeholder="Feedback for the announcement writer"
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
          <p className="direct-note">Your decision resumes the announcement writer directly.</p>
        </div>
      )}

      {phase === "applying_decision" && decision && (
        <div className="loading-card"><span className="spinner" /> Sending “{decision}” to the announcement writer…</div>
      )}

      {workerComplete && (
        <div className="complete-card">
          <span aria-hidden="true">✓</span>
          <div>
            <strong>{completionTitle}</strong>
            <p>{resultText ?? worker.messages.filter((message) => message.type === "ai" && message.text.trim()).at(-1)?.text ?? "The reviewed action completed."}</p>
          </div>
        </div>
      )}

      {(errorText(worker.error) || decisionError) && !interrupt && (
        <p className="error-banner">{errorText(worker.error) ?? decisionError}</p>
      )}
      {phaseError && <p className="error-banner">{phaseError}</p>}
    </section>
  );
}

function EmptyWorkerPanel() {
  return (
    <section className="panel panel--worker panel--empty" aria-labelledby="worker-heading">
      <header className="panel__header">
        <div>
          <span className="eyebrow">Async subagent</span>
          <h2 id="worker-heading">Announcement writer</h2>
        </div>
        <span className="status-dot">Not started</span>
      </header>
      <div className="empty-state">
        <div className="empty-state__glyph" aria-hidden="true">↗</div>
        <h3>No announcement in progress</h3>
        <p>Ask the launch coordinator to prepare an announcement. A writer will draft it in the background.</p>
      </div>
    </section>
  );
}

function ApprovalPage({ threadId }: { threadId: string }) {
  return (
    <>
      <header className="app-header">
        <div className="brand">
          <div className="brand__mark" aria-hidden="true"><span /><span /></div>
          <div>
            <span className="eyebrow">Communications · Human review</span>
            <h1>Approval inbox</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className="server-status"><i /> Local Agent Server</span>
          <a className="reset-button" href="/">End-user view</a>
        </div>
      </header>

      <main className="approval-workspace">
        <div className="approval-context">
          <span className="eyebrow">Assigned review</span>
          <h2>Product launch announcement</h2>
          <p>
            This is the approver’s separate view. Its decision resumes the
            independent sub-agent directly.
          </p>
          <div className="thread-meta approval-context__thread">
            <span>Sub-agent thread</span>
            <code title={threadId}>{shortId(threadId)}</code>
          </div>
        </div>
        <SubagentPanel threadId={threadId} mode="approval" />
      </main>
    </>
  );
}

function DemoSession({ onReset }: { onReset: () => void }) {
  const orchestrator = useStream<AgentState>({
    assistantId: "orchestrator",
    apiUrl: API_URL,
  });
  const [input, setInput] = useState("Prepare the product launch announcement for the company newsroom.");
  const tasks = Object.entries(orchestrator.values.async_tasks ?? {});
  const workerThreadId = tasks[0]?.[0];

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
            <span className="eyebrow">Communications · Launch operations</span>
            <h1>Announcement control room</h1>
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
              <span className="eyebrow">Orchestrator</span>
              <h2 id="orchestrator-heading">Launch coordinator</h2>
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
                <h3>Plan the announcement</h3>
                <p>Ask the coordinator to prepare a product launch. It will assign a writer and stay available.</p>
              </div>
            )}
            {orchestrator.messages.map((message, index) => (
              <MessageBubble key={message.id ?? index} message={message} />
            ))}
            {orchestrator.isLoading && <div className="typing"><i /><i /><i /></div>}
          </div>

          {errorText(orchestrator.error) && <p className="error-banner">{errorText(orchestrator.error)}</p>}

          <form className="composer" onSubmit={(event) => void submit(event)}>
            <label htmlFor="chat-input">Message launch coordinator</label>
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
        </section>

        {workerThreadId ? (
          <SubagentPanel key={workerThreadId} mode="status" threadId={workerThreadId} />
        ) : (
          <EmptyWorkerPanel />
        )}
      </main>

      <footer className="app-footer">
        <span>Launch coordinator + independent announcement writer</span>
        <span>Publication approval resumes the writer directly</span>
      </footer>
    </>
  );
}

function EndUserApp() {
  const [session, setSession] = useState(0);
  return <DemoSession key={session} onReset={() => setSession((value) => value + 1)} />;
}

export function App() {
  const approvalRoute = window.location.pathname.match(/^\/approvals\/([^/]+)\/?$/);
  if (approvalRoute) {
    return <ApprovalPage threadId={decodeURIComponent(approvalRoute[1])} />;
  }
  return <EndUserApp />;
}
