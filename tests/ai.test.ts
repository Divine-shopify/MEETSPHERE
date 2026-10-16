import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as transcription from "@/app/api/meetings/[code]/transcription/route";
import * as consent from "@/app/api/meetings/[code]/consent/route";
import * as captions from "@/app/api/meetings/[code]/captions/route";
import * as notes from "@/app/api/meetings/[code]/notes/route";
import * as summarize from "@/app/api/meetings/[code]/notes/summarize/route";
import { hostWithMeeting, joinAs, setPlan } from "./helpers";

// A local stand-in for the Messages API streaming endpoint. It checks the
// request we send and replies with a well-formed SSE stream. It does NOT
// exercise the real model.
describe("AI meeting summaries (mock Messages API)", () => {
  let server: Server;
  let lastRequest: { url: string; headers: Record<string, string | string[] | undefined>; body: any } | null = null;
  let reply = { summary: "", decisions: [] as string[], action_items: [] as unknown[] };
  let stopReason = "end_turn";

  beforeAll(async () => {
    server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        lastRequest = { url: req.url!, headers: req.headers, body: JSON.parse(raw) };
        const text = JSON.stringify(reply);
        const events: Array<[string, unknown]> = [
          ["message_start", { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(0, 20) } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: text.slice(20) } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 80 } }],
          ["message_stop", { type: "message_stop" }],
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    process.env.ANTHROPIC_API_KEY = "test-key";
    process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_BASE_URL;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("sends only consented transcript + notes, with structured output and fallbacks, and stores the result", async () => {
    const { host, user, code } = await hostWithMeeting({ accessPolicy: "anyone_with_link" });
    await setPlan(user.id, "pro");
    const { b: yes } = await joinAs(code, "Yara");
    const { b: no } = await joinAs(code, "Noah");
    await host.call(transcription.POST, { params: { code }, body: { on: true } });
    await yes.call(consent.POST, { params: { code }, body: { kind: "transcription", granted: true } });
    await no.call(consent.POST, { params: { code }, body: { kind: "transcription", granted: false } });
    await yes.call(captions.POST, { params: { code }, body: { text: "Let's launch on March 3rd. Sam owns the press release." } });
    await no.call(captions.POST, { params: { code }, body: { text: "PRIVATE REMARK" } });
    await host.call(notes.PUT, { method: "PUT", params: { code }, body: { hostNotes: "Budget approved." } });

    reply = {
      summary: "The team agreed on a March 3rd launch.",
      decisions: ["Launch on March 3rd"],
      action_items: [{ task: "Write the press release", owner: "Sam", due: null }],
    };
    const r = await host.call(summarize.POST, { params: { code }, body: {} });
    expect(r.status).toBe(200);
    expect(r.body.notes).toMatchObject({ summary: "The team agreed on a March 3rd launch.", decisions: ["Launch on March 3rd"] });
    expect(r.body.notes.action_items[0]).toMatchObject({ task: "Write the press release", owner: "Sam" });

    const req = lastRequest!;
    expect(req.url).toContain("/v1/messages");
    expect(String(req.headers["anthropic-beta"])).toContain("server-side-fallback-2026-07-01");
    expect(req.body.model).toBe("claude-opus-5-5");
    expect(req.body.fallbacks).toBe("default");
    expect(req.body.stream).toBe(true);
    expect(req.body.output_config.format.type).toBe("json_schema");
    expect(req.body.output_config.effort).toBe("medium");
    expect(req.body.thinking).toBeUndefined();
    const sent = JSON.stringify(req.body.messages);
    expect(sent).toContain("March 3rd");
    expect(sent).toContain("Budget approved.");
    expect(sent).not.toContain("PRIVATE REMARK");
  });

  it("reports refusals and truncation instead of storing garbage", async () => {
    const { host, user, code } = await hostWithMeeting();
    await setPlan(user.id, "pro");
    await host.call(notes.PUT, { method: "PUT", params: { code }, body: { hostNotes: "Something to summarize." } });
    stopReason = "refusal";
    expect((await host.call(summarize.POST, { params: { code }, body: {} })).body.error.code).toBe("ai_refused");
    stopReason = "max_tokens";
    expect((await host.call(summarize.POST, { params: { code }, body: {} })).body.error.code).toBe("ai_truncated");
    stopReason = "end_turn";
    const n = await host.call(notes.GET, { params: { code } });
    expect(n.body.notes.summary).toBeNull();
  });
});
