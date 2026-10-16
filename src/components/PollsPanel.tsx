"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Alert, Check, useAction } from "./ui";

interface Poll {
  id: string;
  question: string;
  options: string[];
  allowMultiple: boolean;
  anonymous: boolean;
  status: "draft" | "open" | "closed";
  resultsVisible: boolean;
  myVote: number[] | null;
  totalVotes: number;
  results: number[] | null;
  voters: string[][] | null;
}

export function PollsPanel({ code, moderator, version }: { code: string; moderator: boolean; version: number }) {
  const [polls, setPolls] = useState<Poll[]>([]);
  const [creating, setCreating] = useState(false);
  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [anonymous, setAnonymous] = useState(true);
  const [choice, setChoice] = useState<Record<string, number[]>>({});
  const { busy, error, run } = useAction();

  useEffect(() => {
    api(`/api/meetings/${code}/polls`).then((r) => setPolls(r.polls), () => {});
  }, [code, version]);

  async function create(launch: boolean) {
    const r = await run(() =>
      api(`/api/meetings/${code}/polls`, { body: { question, options: options.filter((o) => o.trim()), allowMultiple: multi, anonymous, launch } }),
    );
    if (r) {
      setCreating(false);
      setQuestion("");
      setOptions(["", ""]);
    }
  }
  const manage = (id: string, action: string) => run(() => api(`/api/meetings/${code}/polls/${id}/manage`, { body: { action } }));
  const vote = (id: string) => run(() => api(`/api/meetings/${code}/polls/${id}/vote`, { body: { options: choice[id] } }));

  return (
    <div className="stack">
      {error && <Alert kind="error">{error}</Alert>}
      {moderator &&
        (creating ? (
          <div className="stack card" style={{ background: "transparent" }}>
            <label htmlFor="poll-q">Question</label>
            <input id="poll-q" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} />
            {options.map((o, i) => (
              <input
                key={i}
                aria-label={`Option ${i + 1}`}
                placeholder={`Option ${i + 1}`}
                value={o}
                maxLength={120}
                onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))}
              />
            ))}
            {options.length < 10 && <button className="small" onClick={() => setOptions([...options, ""])}>+ Add option</button>}
            <Check checked={multi} onChange={setMulti} label="Allow multiple answers" />
            <Check checked={anonymous} onChange={setAnonymous} label="Anonymous (hosts see totals only)" />
            <div className="row">
              <button className="small primary" disabled={busy || !question.trim() || options.filter((o) => o.trim()).length < 2} onClick={() => create(true)}>Launch now</button>
              <button className="small" disabled={busy || !question.trim()} onClick={() => create(false)}>Save draft</button>
              <button className="small" onClick={() => setCreating(false)}>Cancel</button>
            </div>
          </div>
        ) : (
          <button className="small primary" onClick={() => setCreating(true)}>New poll</button>
        ))}
      {polls.length === 0 && <p className="small muted">No polls yet.</p>}
      {polls.map((p) => {
        const picked = choice[p.id] ?? p.myVote ?? [];
        const max = Math.max(1, ...(p.results ?? [0]));
        return (
          <div key={p.id} className="stack" style={{ borderTop: "1px solid #2c3444", paddingTop: 10 }}>
            <div className="row spread">
              <strong>{p.question}</strong>
              <span className="badge">{p.status === "open" ? "Open" : p.status === "closed" ? "Closed" : "Draft"}</span>
            </div>
            {p.options.map((o, i) => (
              <div key={i} className="stack" style={{ gap: 4 }}>
                {p.status === "open" ? (
                  <label className="check">
                    <input
                      type={p.allowMultiple ? "checkbox" : "radio"}
                      name={`poll-${p.id}`}
                      checked={picked.includes(i)}
                      onChange={(e) =>
                        setChoice({ ...choice, [p.id]: p.allowMultiple ? (e.target.checked ? [...picked, i] : picked.filter((x) => x !== i)) : [i] })
                      }
                    />
                    <span>{o}</span>
                  </label>
                ) : (
                  <span>{o}</span>
                )}
                {p.results && (
                  <div className="row" style={{ gap: 6 }}>
                    <div className="bar" style={{ flex: 1 }} aria-hidden><span style={{ width: `${(p.results[i] / max) * 100}%` }} /></div>
                    <span className="small">{p.results[i]}</span>
                  </div>
                )}
                {p.voters?.[i]?.length ? <span className="small muted">{p.voters[i].join(", ")}</span> : null}
              </div>
            ))}
            <div className="row">
              {p.status === "open" && (
                <button className="small primary" disabled={busy || !picked.length} onClick={() => vote(p.id)}>
                  {p.myVote ? "Change vote" : "Vote"}
                </button>
              )}
              {p.myVote && <span className="small muted">Your vote is in.</span>}
              <span className="small muted">{p.totalVotes} vote{p.totalVotes === 1 ? "" : "s"}</span>
            </div>
            {moderator && (
              <div className="row">
                {p.status !== "open" && <button className="small" onClick={() => manage(p.id, "open")}>{p.status === "draft" ? "Launch" : "Reopen"}</button>}
                {p.status === "open" && <button className="small" onClick={() => manage(p.id, "close")}>Close</button>}
                <button className="small" onClick={() => manage(p.id, p.resultsVisible ? "hide_results" : "show_results")}>
                  {p.resultsVisible ? "Hide results" : "Share results"}
                </button>
                <button className="small danger" onClick={() => manage(p.id, "delete")}>Delete</button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
