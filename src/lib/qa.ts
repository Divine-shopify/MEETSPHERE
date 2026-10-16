import { z } from "zod";
import { one, query, tx } from "./db";
import { badRequest, forbidden, notFound } from "./errors";
import { publish } from "./events";
import type { Meeting } from "./meetings";
import { enforce } from "./ratelimit";
import type { Viewer } from "./viewer";
import { emitWebhook } from "./webhooks";

export const askSchema = z.object({ body: z.string().trim().min(1).max(500), anonymous: z.boolean().default(false) });
export const moderateSchema = z.object({ action: z.enum(["approve", "answer", "dismiss", "reopen", "pin", "unpin"]) });

interface QuestionRow {
  id: string;
  author_key: string;
  author_name: string;
  anonymous: boolean;
  body: string;
  status: "pending" | "visible" | "answered" | "dismissed";
  pinned: boolean;
  votes: number;
  created_at: string;
  answered_at: string | null;
  voted: boolean;
}

function changed(m: Meeting, pendingOnly = false) {
  return publish({ meetingId: m.id, type: "qa_changed", audience: pendingOnly ? "moderators" : "all" });
}

export async function ask(m: Meeting, v: Viewer, input: z.infer<typeof askSchema>) {
  if (!m.qa_enabled) throw forbidden("Q&A is turned off for this meeting.");
  if (!v.key) throw forbidden("Join the meeting to ask a question.");
  if (input.anonymous && !m.qa_anonymous_allowed) throw badRequest("The host doesn't allow anonymous questions.");
  await enforce(`qa:${v.key}`, 5, 60, "You're asking questions very quickly. Wait a moment.");
  const status = m.qa_moderated && !v.moderator ? "pending" : "visible";
  const q = await one<{ id: string }>(
    `INSERT INTO questions (meeting_id, author_key, author_name, anonymous, body, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [m.id, v.key, v.name || "Guest", input.anonymous, input.body, status],
  );
  await changed(m, status === "pending");
  await emitWebhook(m, "question.asked", { questionId: q!.id, body: input.body, anonymous: input.anonymous });
  return { id: q!.id, status };
}

export async function list(m: Meeting, v: Viewer) {
  const rows = await query<QuestionRow>(
    `SELECT q.id, q.author_key, q.author_name, q.anonymous, q.body, q.status, q.pinned, q.votes, q.created_at, q.answered_at,
            EXISTS (SELECT 1 FROM question_votes qv WHERE qv.question_id = q.id AND qv.voter_key = $2) AS voted
       FROM questions q
      WHERE q.meeting_id = $1
        AND ($3 OR q.status IN ('visible', 'answered') OR (q.status = 'pending' AND q.author_key = $2))
      ORDER BY q.pinned DESC, (q.status = 'answered'), q.votes DESC, q.created_at`,
    [m.id, v.key ?? "", v.moderator],
  );
  return rows.map((r) => ({
    id: r.id,
    // Anonymous means anonymous to everyone, including the host.
    author: r.anonymous ? "Anonymous" : r.author_name,
    mine: r.author_key === v.key,
    body: r.body,
    status: r.status,
    pinned: r.pinned,
    votes: r.votes,
    voted: r.voted,
    createdAt: r.created_at,
  }));
}

export async function vote(m: Meeting, v: Viewer, questionId: string, up: boolean) {
  if (!v.key) throw forbidden("Join the meeting to vote.");
  if (!/^[0-9a-f-]{36}$/.test(questionId)) throw notFound("Question not found");
  await tx(async (db) => {
    const q = await one<{ status: string }>("SELECT status FROM questions WHERE id = $1 AND meeting_id = $2 FOR UPDATE", [questionId, m.id], db);
    if (!q || (q.status !== "visible" && q.status !== "answered")) throw notFound("Question not found");
    const res = up
      ? await db.query("INSERT INTO question_votes (question_id, voter_key) VALUES ($1, $2) ON CONFLICT DO NOTHING", [questionId, v.key])
      : await db.query("DELETE FROM question_votes WHERE question_id = $1 AND voter_key = $2", [questionId, v.key]);
    if (res.rowCount) await db.query(`UPDATE questions SET votes = votes ${up ? "+" : "-"} 1 WHERE id = $1`, [questionId]);
  });
  await changed(m);
}

export async function moderate(m: Meeting, v: Viewer, questionId: string, action: z.infer<typeof moderateSchema>["action"]) {
  if (!v.moderator) throw forbidden();
  if (!/^[0-9a-f-]{36}$/.test(questionId)) throw notFound("Question not found");
  const sql: Record<typeof action, string> = {
    approve: "status = 'visible'",
    answer: "status = 'answered', answered_at = now(), pinned = false",
    dismiss: "status = 'dismissed', pinned = false",
    reopen: "status = 'visible', answered_at = NULL",
    pin: "pinned = true",
    unpin: "pinned = false",
  };
  const res = await one(`UPDATE questions SET ${sql[action]} WHERE id = $1 AND meeting_id = $2 RETURNING id`, [questionId, m.id]);
  if (!res) throw notFound("Question not found");
  await changed(m);
}
