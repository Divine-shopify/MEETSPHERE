"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Alert, Check, useAction } from "./ui";

interface Question {
  id: string;
  author: string;
  mine: boolean;
  body: string;
  status: "pending" | "visible" | "answered" | "dismissed";
  pinned: boolean;
  votes: number;
  voted: boolean;
}

export function QAPanel({ code, moderator, version, allowAnonymous, moderated }: { code: string; moderator: boolean; version: number; allowAnonymous: boolean; moderated: boolean }) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [body, setBody] = useState("");
  const [anonymous, setAnonymous] = useState(false);
  const [filter, setFilter] = useState<"open" | "answered" | "pending">("open");
  const { busy, error, notice, run } = useAction();

  useEffect(() => {
    api(`/api/meetings/${code}/questions`).then((r) => setQuestions(r.questions), () => {});
  }, [code, version]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    const r = await run(() => api(`/api/meetings/${code}/questions`, { body: { body, anonymous } }));
    if (r) {
      setBody("");
      if (r.status === "pending") await run(async () => {}, "Sent. The host will review it before it's shown.");
    }
  }
  const act = (id: string, action: string, payload: object) => run(() => api(`/api/meetings/${code}/questions/${id}/${action}`, { body: payload }));

  const shown = questions.filter((q) =>
    filter === "pending" ? q.status === "pending" : filter === "answered" ? q.status === "answered" : q.status === "visible" || (q.status === "pending" && q.mine && !moderator),
  );
  const pendingCount = questions.filter((q) => q.status === "pending").length;

  return (
    <div className="stack">
      <form onSubmit={ask} className="stack">
        <label htmlFor="qa-body" className="sr-only">Your question</label>
        <textarea id="qa-body" rows={2} maxLength={500} placeholder="Ask a question…" value={body} onChange={(e) => setBody(e.target.value)} />
        <div className="row spread">
          {allowAnonymous ? <Check checked={anonymous} onChange={setAnonymous} label="Ask anonymously" /> : <span />}
          <button className="small primary" disabled={busy || !body.trim()}>Ask</button>
        </div>
        {moderated && !moderator && <p className="small muted">Questions are reviewed by the host before everyone sees them.</p>}
      </form>
      {error && <Alert kind="error">{error}</Alert>}
      {notice && <Alert>{notice}</Alert>}
      <div className="segmented" role="group" aria-label="Filter questions">
        <button aria-pressed={filter === "open"} onClick={() => setFilter("open")}>Open</button>
        <button aria-pressed={filter === "answered"} onClick={() => setFilter("answered")}>Answered</button>
        {moderator && <button aria-pressed={filter === "pending"} onClick={() => setFilter("pending")}>Review ({pendingCount})</button>}
      </div>
      {shown.length === 0 ? (
        <p className="small muted">No questions here yet.</p>
      ) : (
        <ul className="list">
          {shown.map((q) => (
            <li key={q.id} className="stack" style={{ gap: 6 }}>
              <div>{q.pinned && <span className="badge">Pinned</span>} {q.body}</div>
              <div className="row spread small muted">
                <span>{q.author}{q.status === "pending" ? " · awaiting review" : ""}</span>
                {q.status !== "pending" && (
                  <button className="small" aria-pressed={q.voted} onClick={() => act(q.id, "vote", { up: !q.voted })} aria-label={`Upvote (${q.votes})`}>
                    ▲ {q.votes}
                  </button>
                )}
              </div>
              {moderator && (
                <div className="row">
                  {q.status === "pending" && <button className="small primary" onClick={() => act(q.id, "moderate", { action: "approve" })}>Approve</button>}
                  {q.status === "visible" && <button className="small" onClick={() => act(q.id, "moderate", { action: "answer" })}>Mark answered</button>}
                  {q.status === "answered" && <button className="small" onClick={() => act(q.id, "moderate", { action: "reopen" })}>Reopen</button>}
                  {q.status === "visible" && (
                    <button className="small" onClick={() => act(q.id, "moderate", { action: q.pinned ? "unpin" : "pin" })}>{q.pinned ? "Unpin" : "Pin"}</button>
                  )}
                  <button className="small danger" onClick={() => act(q.id, "moderate", { action: "dismiss" })}>Dismiss</button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
