import { useCallback, useEffect, useState } from "react";

import { Runtime, type Info } from "./mygo";

type Probe =
  | { state: "checking" }
  | { state: "ok"; detail: string }
  | { state: "warn"; detail: string }
  | { state: "bad"; detail: string };

/**
 * The window is a shell for now: it reports what it can reach and says plainly
 * what is not wired yet. The chat surface arrives once the agent runtime speaks
 * to the backend, so none of it is faked here.
 */
export function App() {
  const [info, setInfo] = useState<Info | null>(null);
  const [backend, setBackend] = useState<Probe>({ state: "checking" });

  const probe = useCallback(async (baseUrl: string) => {
    setBackend({ state: "checking" });
    const started = performance.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 3000);
    try {
      const res = await fetch(`${baseUrl}/healthz`, { signal: ac.signal });
      const ms = Math.round(performance.now() - started);
      if (!res.ok) {
        setBackend({ state: "bad", detail: `GET /healthz answered ${res.status}` });
        return;
      }
      const body = (await res.json()) as { version?: string };
      setBackend({
        state: "ok",
        detail: `v${body.version ?? "?"} · ${ms}ms · ${baseUrl}`,
      });
    } catch {
      setBackend({
        state: "bad",
        detail: `no answer from ${baseUrl} — start it with: make backend`,
      });
    } finally {
      clearTimeout(timer);
    }
  }, []);

  useEffect(() => {
    Runtime.info()
      .then((next) => {
        setInfo(next);
        void probe(next.apiBaseUrl);
      })
      .catch(() => setBackend({ state: "bad", detail: "Go bindings unavailable" }));
  }, [probe]);

  return (
    <div className="shell">
      <aside className="rail">
        <h1 className="wordmark">
          vessel <small>{info ? `v${info.version}` : "…"}</small>
        </h1>
        <ul className="nav">
          <li data-active="true">Overview</li>
          <li>
            Sessions <span className="soon">soon</span>
          </li>
          <li>
            Runtime <span className="soon">soon</span>
          </li>
          <li>
            Settings <span className="soon">soon</span>
          </li>
        </ul>
        <div className="rail-foot">
          <span>{info ? `${info.os}/${info.arch}` : "detecting platform"}</span>
          <span>{info?.goVersion ?? ""}</span>
          <span>{info?.apiBaseUrl ?? ""}</span>
        </div>
      </aside>

      <main className="main">
        <div className="main-inner">
          <p className="eyebrow">Monorepo scaffold · macOS &amp; iOS</p>
          <h1>Your agent, in one window.</h1>
          <p className="lede">
            Vessel is an open-source coding agent: a Go backend, a TypeScript agent
            runtime, and this MyGo shell that runs on macOS and iOS from one codebase.
          </p>

          <section>
            <div className="section-head">
              <h2>Connectivity</h2>
              <button
                type="button"
                onClick={() => info && void probe(info.apiBaseUrl)}
                disabled={!info}
              >
                Re-check
              </button>
            </div>
            <dl className="rows">
              <div className="row">
                <dt>Backend</dt>
                <dd>
                  Go · chi · pgx · Postgres
                  <div className="detail">
                    {backend.state === "checking" ? "asking /healthz…" : backend.detail}
                  </div>
                </dd>
                <Pill state={backend.state} />
              </div>
              <div className="row">
                <dt>Agent runtime</dt>
                <dd>
                  TypeScript · Pi coding agent SDK
                  <div className="detail">
                    apps/agent-runtime — runs on its own; not connected to this window yet
                  </div>
                </dd>
                <span className="pill" data-state="idle">
                  not wired
                </span>
              </div>
              <div className="row">
                <dt>This window</dt>
                <dd>
                  Go shell · React page · WebKit on macOS and iOS
                  <div className="detail">
                    {info ? `mygo · ${info.os}/${info.arch}` : "loading Go bindings…"}
                  </div>
                </dd>
                <span className="pill" data-state="ok">
                  <span className="dot" />
                  running
                </span>
              </div>
            </dl>
          </section>

          <section>
            <div className="section-head">
              <h2>What this build is</h2>
            </div>
            <div className="note">
              <p>
                <strong>Three projects, one repo.</strong> The backend owns persistence
                and the HTTP API; the agent runtime owns the session, tools and access
                modes; this app owns the interface.
              </p>
              <p>
                Nothing pretends to work: the agent is not attached to the backend yet, so
                this window only reports the state of the pieces you can start.
              </p>
              <p className="mono">make db · make backend · bun run desktop:dev</p>
            </div>
          </section>

          <div className="foot">
            <span>Apache-2.0</span>
            <span>docs/architecture.md</span>
            <span>localhost only by default</span>
          </div>
        </div>
      </main>
    </div>
  );
}

function Pill({ state }: { state: Probe["state"] }) {
  const label =
    state === "ok" ? "reachable" : state === "bad" ? "unreachable" : "checking";
  return (
    <span className="pill" data-state={state}>
      <span className="dot" />
      {label}
    </span>
  );
}
