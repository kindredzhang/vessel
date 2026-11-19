import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Runtime, type Info } from "./mygo";
import {
  ACCESS_MODES,
  MODE_INFO,
  RuntimeClient,
  type AccessMode,
  type Decision,
  type Message,
  type SessionView,
  type TurnEvent,
} from "./api";

type Status = { state: "checking" } | { state: "ready" } | { state: "offline"; detail: string };

interface ToolRow {
  key: number;
  name: string;
  summary?: string;
  isError?: boolean;
}

interface Approval {
  requestId: string;
  description: string;
  toolName: string;
  risk: string;
  mode: AccessMode;
}

const SUGGESTIONS = [
  "Explain the layout of this repository",
  "Run the tests and fix whatever breaks",
  "Add a Makefile target that prints the running containers",
];

export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [status, setStatus] = useState<Status>({ state: "checking" });
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mode, setMode] = useState<AccessMode>("ask");
  const [model, setModel] = useState<string>("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [tools, setTools] = useState<ToolRow[]>([]);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const client = useMemo(() => (info ? new RuntimeClient(info.agentUrl) : null), [info]);
  const abort = useRef<AbortController | null>(null);
  const transcript = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  const connect = useCallback(
    async (runtime: RuntimeClient) => {
      setStatus({ state: "checking" });
      try {
        await runtime.health();
        const list = await runtime.listSessions();
        setSessions(list);
        setStatus({ state: "ready" });
      } catch (cause) {
        setStatus({
          state: "offline",
          detail: cause instanceof Error ? cause.message : String(cause),
        });
      }
    },
    [],
  );

  useEffect(() => {
    Runtime.info()
      .then((next) => {
        setInfo(next);
        void connect(new RuntimeClient(next.agentUrl));
      })
      .catch(() => {
        // Browser-only development (`bun run dev:web`) has no Go side; fall back
        // to the local runtime so the same page can be worked on in a tab.
        const fallback: Info = {
          app: "vessel",
          version: "web",
          os: "web",
          arch: "",
          goVersion: "",
          apiBaseUrl: "http://localhost:8080",
          agentUrl: import.meta.env.VITE_AGENT_URL ?? "http://127.0.0.1:8787",
        };
        setInfo(fallback);
        void connect(new RuntimeClient(fallback.agentUrl));
      });
  }, [connect]);

  useEffect(() => {
    const node = transcript.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [messages, streamText, tools, approval]);

  const open = useCallback(
    async (id: string) => {
      if (!client) return;
      setActiveId(id);
      setError(null);
      setStreamText("");
      setTools([]);
      setApproval(null);
      try {
        const session = await client.getSession(id);
        setMessages(session.messages);
        setMode(session.accessMode);
        setModel(session.model.name);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [client],
  );

  const startSession = useCallback(async (): Promise<SessionView | null> => {
    if (!client) return null;
    try {
      const session = await client.createSession(mode);
      setSessions((previous) => [session, ...previous]);
      setActiveId(session.id);
      setMessages([]);
      setModel(session.model.name);
      setError(null);
      return session;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    }
  }, [client, mode]);

  const send = useCallback(
    async (prompt: string) => {
      const text = prompt.trim();
      if (!text || !client || busy) return;
      setError(null);
      setNotice(null);
      setDraft("");

      let id = activeIdRef.current;
      if (!id) {
        const created = await startSession();
        if (!created) return;
        id = created.id;
      }

      setMessages((previous) => [...previous, { role: "user", text, at: new Date().toISOString() }]);
      setBusy(true);
      setStreamText("");
      setTools([]);
      let assistant = "";
      const controller = new AbortController();
      abort.current = controller;

      try {
        for await (const event of client.turn(id, text, controller.signal)) {
          apply(event);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      } finally {
        abort.current = null;
        setBusy(false);
        setStreamText("");
        setTools([]);
        setApproval(null);
      }

      function apply(event: TurnEvent): void {
        switch (event.type) {
          case "text":
            assistant += event.delta;
            setStreamText(assistant);
            break;
          case "thinking":
            break;
          case "tool":
            if (event.phase === "start") {
              setTools((previous) => [...previous, { key: previous.length, name: event.name, summary: event.summary }]);
            } else {
              setTools((previous) => {
                const next = [...previous];
                const last = next[next.length - 1];
                if (last && last.name === event.name) next[next.length - 1] = { ...last, isError: event.isError };
                return next;
              });
            }
            break;
          case "approval":
            setApproval({
              requestId: event.requestId,
              description: event.description,
              toolName: event.toolName,
              risk: event.risk,
              mode: event.mode,
            });
            break;
          case "done":
            setMessages(event.messages);
            setMode(event.accessMode);
            setStreamText("");
            setTools([]);
            if (event.silent) {
              setNotice(
                "The model returned no text — its reasoning may have used the whole budget. Try again, or start the runtime with VESSEL_THINKING=off.",
              );
            }
            break;
          case "error":
            setError(event.message);
            break;
          case "start":
            break;
        }
      }
    },
    [busy, client, startSession],
  );

  const decide = useCallback(
    async (decision: Decision) => {
      if (!client || !activeId || !approval) return;
      try {
        await client.decide(activeId, approval.requestId, decision);
        setApproval(null);
        if (decision === "auto" || decision === "full") setMode(decision);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeId, approval, client],
  );

  const changeMode = useCallback(
    async (next: AccessMode) => {
      setMode(next);
      if (!client || !activeId) return;
      try {
        const session = await client.setMode(activeId, next);
        setMode(session.accessMode);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeId, client],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
  }, []);

  const remove = useCallback(
    async (id: string) => {
      if (!client) return;
      try {
        await client.deleteSession(id);
        setSessions((previous) => previous.filter((session) => session.id !== id));
        if (activeId === id) {
          setActiveId(null);
          setMessages([]);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeId, client],
  );

  const offline = status.state === "offline";
  const lastAssistant = messages.filter((message) => message.role === "assistant").length;

  return (
    <div className="app">
      <aside className="rail">
        <div className="rail-head">
          <h1 className="wordmark">
            vessel <small>{info ? `v${info.version}` : "…"}</small>
          </h1>
          <button type="button" className="new-session" onClick={() => void startSession()} disabled={offline}>
            <span aria-hidden>+</span> New session
          </button>
        </div>

        <ul className="threads">
          {sessions.length === 0 && <li className="threads-empty">No sessions yet</li>}
          {sessions.map((session) => (
            <li key={session.id}>
              <button
                type="button"
                data-active={session.id === activeId}
                onClick={() => void open(session.id)}
              >
                <span className="thread-title">
                  {session.messages.find((message) => message.role === "user")?.text.slice(0, 42) ??
                    "New session"}
                </span>
                <span className="thread-meta">
                  {MODE_INFO[session.accessMode].label} · {time(session.createdAt)}
                </span>
              </button>
              <button
                type="button"
                className="thread-remove"
                aria-label="Delete session"
                onClick={() => void remove(session.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>

        <div className="rail-foot">
          <span className="state" data-state={status.state}>
            <span className="dot" />
            {status.state === "ready" ? "runtime ready" : status.state === "checking" ? "connecting…" : "runtime offline"}
          </span>
          <span className="endpoint">{info?.agentUrl ?? "…"}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-model">
            {model ? `${model}` : "no model loaded"}
            <span className="topbar-cwd">
              {info ? (info.arch ? `${info.os}/${info.arch}` : info.os) : ""}
            </span>
          </div>
          <div className="modes" role="group" aria-label="File access mode">
            {ACCESS_MODES.map((candidate) => (
              <button
                key={candidate}
                type="button"
                data-active={candidate === mode}
                title={MODE_INFO[candidate].hint}
                onClick={() => void changeMode(candidate)}
                disabled={busy}
              >
                {MODE_INFO[candidate].label}
              </button>
            ))}
          </div>
        </header>

        <div className="transcript" ref={transcript}>
          {error && (
            <div className="error" role="alert">
              <strong>Something went wrong</strong>
              <span>{error}</span>
              <button type="button" className="ghost" onClick={() => setError(null)}>
                Dismiss
              </button>
            </div>
          )}
          {notice && (
            <p className="notice">
              {notice}
              <button type="button" className="link" onClick={() => setNotice(null)}>
                dismiss
              </button>
            </p>
          )}
          {offline ? (
            <div className="placeholder">
              <h2>The agent runtime isn’t answering.</h2>
              <p className="lede">
                Vessel talks to the agent over HTTP. Start it in the repo root, then reconnect.
              </p>
              <pre className="command">bun run serve</pre>
              <p className="detail">{status.detail}</p>
              <button type="button" onClick={() => client && void connect(client)}>
                Try again
              </button>
            </div>
          ) : messages.length === 0 && !busy ? (
            <div className="placeholder">
              <p className="eyebrow">Pi coding agent SDK · {MODE_INFO[mode].label} mode</p>
              <h2>Ask it to do something.</h2>
              <p className="lede">
                It reads, runs commands and edits files in this repository. In {MODE_INFO[mode].label.toLowerCase()} mode,{" "}
                {MODE_INFO[mode].hint}.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    type="button"
                    onClick={() => {
                      setDraft(suggestion);
                      composer.current?.focus();
                    }}
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="column">
              {messages.map((message, index) => (
                <article key={`${message.at}-${index}`} className="turn" data-role={message.role}>
                  <span className="turn-label">{message.role === "user" ? "you" : "vessel"}</span>
                  <div className="turn-body">{message.text}</div>
                </article>
              ))}

              {(busy || streamText || tools.length > 0) && (
                <article className="turn" data-role="assistant">
                  <span className="turn-label">vessel</span>
                  <div className="turn-body">
                    {tools.map((tool) => (
                      <div key={tool.key} className="tool" data-error={tool.isError === true}>
                        <span className="tool-mark">{tool.isError ? "✗" : "⏺"}</span>
                        <span className="tool-name">{tool.name}</span>
                        {tool.summary && <span className="tool-args">{tool.summary}</span>}
                      </div>
                    ))}
                    {streamText && <div className="stream">{streamText}</div>}
                    {busy && !streamText && tools.length === 0 && (
                      <div className="working">
                        <span />
                        <span />
                        <span />
                      </div>
                    )}
                  </div>
                </article>
              )}

              {approval && (
                <div className="approval" data-risk={approval.risk}>
                  <div className="approval-head">
                    <span className="approval-mark">⚠</span>
                    <div>
                      <strong>Approval needed</strong>
                      <span className="approval-meta">
                        {approval.toolName} · risk {approval.risk} · {MODE_INFO[approval.mode].label} mode
                      </span>
                    </div>
                  </div>
                  <pre className="approval-call">{approval.description}</pre>
                  <div className="approval-actions">
                    <button type="button" className="primary" onClick={() => void decide("allow")}>
                      Allow once
                    </button>
                    <button type="button" onClick={() => void decide("always")}>
                      Always this session
                    </button>
                    <button type="button" onClick={() => void decide("deny")}>
                      Deny
                    </button>
                    <button type="button" className="ghost" onClick={() => void decide("auto")}>
                      Switch to Auto
                    </button>
                  </div>
                </div>
              )}

              {error && (
                <div className="error">
                  <strong>Turn failed</strong>
                  <span>{error}</span>
                </div>
              )}
            </div>
          )}
        </div>

        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send(draft);
          }}
        >
          <textarea
            ref={composer}
            value={draft}
            rows={1}
            placeholder={offline ? "runtime offline — start it with bun run serve" : "Ask, or tell it what to change…"}
            disabled={offline}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(draft);
              }
            }}
          />
          {busy ? (
            <button type="button" className="send stop" onClick={stop} title="Stop the turn">
              Stop
            </button>
          ) : (
            <button type="submit" className="send" disabled={!draft.trim() || offline}>
              Send
            </button>
          )}
        </form>

        <footer className="statusline">
          <span>{lastAssistant} replies</span>
          <span>{MODE_INFO[mode].hint}</span>
          <span>read · bash · edit · write · grep · find · ls</span>
        </footer>
      </main>
    </div>
  );
}

function time(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.valueOf())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
