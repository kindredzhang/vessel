/**
 * The agent runtime's HTTP API. One JSON request in, one answer out — except
 * turns, which stream server-sent events while the model works.
 */

export const ACCESS_MODES = ["plan", "ask", "auto", "full"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const MODE_INFO: Record<AccessMode, { label: string; hint: string }> = {
  plan: { label: "Plan", hint: "read only, proposes a plan" },
  ask: { label: "Ask", hint: "asks before every edit" },
  auto: { label: "Auto", hint: "edits inside the workspace, asks for the rest" },
  full: { label: "Full", hint: "runs everything except hard blocks" },
};

export interface Message {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface SessionView {
  id: string;
  createdAt: string;
  busy: boolean;
  accessMode: AccessMode;
  model: { id: string; name: string };
  messages: Message[];
}

export type TurnEvent =
  | { type: "start" }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "tool"; phase: "start" | "end"; name: string; summary?: string; isError?: boolean }
  | {
      type: "approval";
      requestId: string;
      mode: AccessMode;
      toolName: string;
      description: string;
      risk: string;
      args: Record<string, unknown>;
      attempt: number;
    }
  | { type: "done"; accessMode: AccessMode; messages: Message[]; silent: boolean }
  | { type: "error"; message: string };

export type Decision = "allow" | "always" | "deny" | "auto" | "full";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function failure(response: Response): Promise<ApiError> {
  let message = `${response.status} ${response.statusText}`;
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    if (body.error?.message) message = body.error.message;
  } catch {
    // not JSON; keep the status line
  }
  return new ApiError(response.status, message);
}

export class RuntimeClient {
  constructor(readonly baseUrl: string) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/$/, "")}${path}`;
  }

  async health(): Promise<{ status: string; sessions: number; busy: number }> {
    const response = await fetch(this.url("/healthz"));
    if (!response.ok) throw await failure(response);
    return (await response.json()) as { status: string; sessions: number; busy: number };
  }

  async listSessions(): Promise<SessionView[]> {
    const response = await fetch(this.url("/v1/sessions"));
    if (!response.ok) throw await failure(response);
    const body = (await response.json()) as { sessions: SessionView[] };
    return body.sessions;
  }

  async createSession(accessMode: AccessMode): Promise<SessionView> {
    const response = await fetch(this.url("/v1/sessions"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ accessMode }),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as SessionView;
  }

  async getSession(id: string): Promise<SessionView> {
    const response = await fetch(this.url(`/v1/sessions/${id}`));
    if (!response.ok) throw await failure(response);
    return (await response.json()) as SessionView;
  }

  async deleteSession(id: string): Promise<void> {
    const response = await fetch(this.url(`/v1/sessions/${id}`), { method: "DELETE" });
    if (!response.ok) throw await failure(response);
  }

  async setMode(id: string, accessMode: AccessMode): Promise<SessionView> {
    const response = await fetch(this.url(`/v1/sessions/${id}/mode`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: accessMode }),
    });
    if (!response.ok) throw await failure(response);
    return (await response.json()) as SessionView;
  }

  async decide(id: string, requestId: string, decision: Decision): Promise<void> {
    const response = await fetch(this.url(`/v1/sessions/${id}/approvals`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId, decision }),
    });
    if (!response.ok) throw await failure(response);
  }

  /** Stream one turn. Yields parsed events until the stream closes. */
  async *turn(id: string, prompt: string, signal?: AbortSignal): AsyncGenerator<TurnEvent> {
    const response = await fetch(this.url(`/v1/sessions/${id}/turns`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
      signal,
    });
    if (!response.ok) throw await failure(response);
    const body = response.body;
    if (!body) throw new Error("this runtime sent no stream");

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const event = parseFrame(frame);
          if (event) yield event;
          cut = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

function parseFrame(frame: string): TurnEvent | undefined {
  let name = "";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith(":")) return undefined; // heartbeat comment
    if (line.startsWith("event: ")) name = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  if (!name) return undefined;
  if (name === "start") return { type: "start" };
  const body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
  switch (name) {
    case "text":
      return { type: "text", delta: String(body.delta ?? "") };
    case "thinking":
      return { type: "thinking", delta: String(body.delta ?? "") };
    case "tool":
      return {
        type: "tool",
        phase: body.phase === "end" ? "end" : "start",
        name: String(body.name ?? "tool"),
        summary: typeof body.summary === "string" ? body.summary : undefined,
        isError: body.isError === true,
      };
    case "approval":
      return {
        type: "approval",
        requestId: String(body.requestId),
        mode: body.mode as AccessMode,
        toolName: String(body.toolName ?? "tool"),
        description: String(body.description ?? ""),
        risk: String(body.risk ?? "unknown"),
        args: (body.args as Record<string, unknown>) ?? {},
        attempt: Number(body.attempt ?? 1),
      };
    case "done":
      return {
        type: "done",
        accessMode: body.accessMode as AccessMode,
        messages: (body.messages as Message[]) ?? [],
        silent: Boolean(body.silent),
      };
    case "error":
      return { type: "error", message: String(body.message ?? "the turn failed") };
    default:
      return undefined;
  }
}
