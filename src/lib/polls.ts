import { z } from "zod";
import { one, query, tx } from "./db";
import { badRequest, conflict, forbidden, notFound } from "./errors";
import { publish } from "./events";
import type { Meeting } from "./meetings";
import type { Viewer } from "./viewer";
import { emitWebhook } from "./webhooks";

export const createPollSchema = z.object({
  question: z.string().trim().min(1).max(300),
  options: z.array(z.string().trim().min(1).max(120)).min(2).max(10),
  allowMultiple: z.boolean().default(false),
  anonymous: z.boolean().default(true),
  launch: z.boolean().default(true),
});
export const pollActionSchema = z.object({ action: z.enum(["open", "close", "show_results", "hide_results", "delete"]) });
export const voteSchema = z.object({ options: z.array(z.number().int().min(0).max(9)).min(1).max(10) });

interface PollRow {
  id: string;
  question: string;
  options: string[];
  allow_multiple: boolean;
  anonymous: boolean;
  results_visible: boolean;
  status: "draft" | "open" | "closed";
  created_at: string;
}

const changed = (m: Meeting) => publish({ meetingId: m.id, type: "polls_changed", audience: "all" });

export async function createPoll(m: Meeting, v: Viewer, input: z.infer<typeof createPollSchema>) {
  if (!v.moderator) throw forbidden();
  if (!m.polls_enabled) throw forbidden("Polls are turned off for this meeting.");
  const p = await one<{ id: string }>(
    `INSERT INTO polls (meeting_id, created_by_key, question, options, allow_multiple, anonymous, status, opened_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [m.id, v.key, input.question, JSON.stringify(input.options), input.allowMultiple, input.anonymous, input.launch ? "open" : "draft", input.launch ? new Date() : null],
  );
  await changed(m);
  return { id: p!.id };
}

export async function actOnPoll(m: Meeting, v: Viewer, pollId: string, action: z.infer<typeof pollActionSchema>["action"]) {
  if (!v.moderator) throw forbidden();
  if (!/^[0-9a-f-]{36}$/.test(pollId)) throw notFound("Poll not found");
  if (action === "delete") {
    const r = await one("DELETE FROM polls WHERE id = $1 AND meeting_id = $2 RETURNING id", [pollId, m.id]);
    if (!r) throw notFound("Poll not found");
  } else {
    const sql = {
      open: "status = 'open', opened_at = coalesce(opened_at, now()), closed_at = NULL",
      close: "status = 'closed', closed_at = now()",
      show_results: "results_visible = true",
      hide_results: "results_visible = false",
    }[action];
    const r = await one<{ question: string }>(`UPDATE polls SET ${sql} WHERE id = $1 AND meeting_id = $2 RETURNING question`, [pollId, m.id]);
    if (!r) throw notFound("Poll not found");
    if (action === "close") {
      const results = (await listPolls(m, { ...v, moderator: true })).find((p) => p.id === pollId);
      await emitWebhook(m, "poll.closed", { pollId, question: r.question, results: results?.results ?? null });
    }
  }
  await changed(m);
}

export async function castVote(m: Meeting, v: Viewer, pollId: string, options: number[]) {
  if (!v.key) throw forbidden("Join the meeting to vote.");
  if (!/^[0-9a-f-]{36}$/.test(pollId)) throw notFound("Poll not found");
  await tx(async (db) => {
    const p = await one<PollRow>("SELECT * FROM polls WHERE id = $1 AND meeting_id = $2", [pollId, m.id], db);
    if (!p) throw notFound("Poll not found");
    if (p.status !== "open") throw conflict("This poll isn't open.", "poll_closed");
    const unique = [...new Set(options)];
    if (unique.some((i) => i >= p.options.length)) throw badRequest("Invalid option.");
    if (!p.allow_multiple && unique.length > 1) throw badRequest("Choose one option.");
    await db.query(
      `INSERT INTO poll_votes (poll_id, voter_key, voter_name, option_indexes) VALUES ($1, $2, $3, $4)
       ON CONFLICT (poll_id, voter_key) DO UPDATE SET option_indexes = EXCLUDED.option_indexes, created_at = now()`,
      [pollId, v.key, p.anonymous ? null : v.name, unique],
    );
  });
  await changed(m);
}

export async function listPolls(m: Meeting, v: Pick<Viewer, "moderator" | "key">) {
  const polls = await query<PollRow>(
    `SELECT * FROM polls WHERE meeting_id = $1 ${v.moderator ? "" : "AND status <> 'draft'"} ORDER BY created_at DESC`,
    [m.id],
  );
  if (polls.length === 0) return [];
  const votes = await query<{ poll_id: string; voter_key: string; voter_name: string | null; option_indexes: number[] }>(
    "SELECT poll_id, voter_key, voter_name, option_indexes FROM poll_votes WHERE poll_id = ANY($1::uuid[])",
    [polls.map((p) => p.id)],
  );
  return polls.map((p) => {
    const mine = votes.filter((x) => x.poll_id === p.id);
    const counts = p.options.map((_, i) => mine.filter((x) => x.option_indexes.includes(i)).length);
    const showResults = v.moderator || p.results_visible;
    return {
      id: p.id,
      question: p.question,
      options: p.options,
      allowMultiple: p.allow_multiple,
      anonymous: p.anonymous,
      status: p.status,
      resultsVisible: p.results_visible,
      myVote: mine.find((x) => x.voter_key === v.key)?.option_indexes ?? null,
      totalVotes: mine.length,
      results: showResults ? counts : null,
      // Named votes only for non-anonymous polls, only for moderators.
      voters:
        v.moderator && !p.anonymous
          ? p.options.map((_, i) => mine.filter((x) => x.option_indexes.includes(i)).map((x) => x.voter_name ?? "Guest"))
          : null,
      createdAt: p.created_at,
    };
  });
}
