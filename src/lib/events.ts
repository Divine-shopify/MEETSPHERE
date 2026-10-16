// Real-time fan-out. Events go through Postgres NOTIFY so every app instance
// receives them; each instance relays to its connected SSE clients.
import { Client } from "pg";
import { config } from "./config";
import { pool, type Db } from "./db";

const CHANNEL = "meetsphere_events";
const MAX_PAYLOAD = 7500; // NOTIFY payloads must stay under 8000 bytes

/** Who may receive an event: everyone in the meeting, moderators only, or one join request. */
export type Audience = "all" | "moderators" | `jr:${string}`;

export interface MeetingEvent {
  meetingId: string;
  type: string;
  audience: Audience;
  data?: Record<string, unknown>;
}

export async function publish(e: MeetingEvent, db: Db = pool()): Promise<void> {
  let payload = JSON.stringify(e);
  if (payload.length > MAX_PAYLOAD) payload = JSON.stringify({ ...e, data: { truncated: true } });
  try {
    await db.query("SELECT pg_notify($1, $2)", [CHANNEL, payload]);
  } catch (err) {
    console.warn("[events] publish failed", (err as Error).message);
  }
}

type Listener = (e: MeetingEvent) => void;

interface Bus {
  client: Client | null;
  connecting: Promise<void> | null;
  listeners: Map<string, Set<Listener>>;
}

const g = globalThis as unknown as { __meetsphereBus?: Bus };
const bus: Bus = (g.__meetsphereBus ??= { client: null, connecting: null, listeners: new Map() });

async function ensureListening(): Promise<void> {
  if (bus.client) return;
  if (bus.connecting) return bus.connecting;
  bus.connecting = (async () => {
    const client = new Client({ connectionString: config.databaseUrl });
    client.on("notification", (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      try {
        const e = JSON.parse(msg.payload) as MeetingEvent;
        bus.listeners.get(e.meetingId)?.forEach((fn) => fn(e));
      } catch {
        /* ignore malformed */
      }
    });
    const reset = () => {
      bus.client = null;
      // Reconnect on next subscription or after a short delay if anyone is listening.
      if (bus.listeners.size) setTimeout(() => ensureListening().catch(() => {}), 1000);
    };
    client.on("error", reset);
    client.on("end", reset);
    await client.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    bus.client = client;
  })().finally(() => {
    bus.connecting = null;
  });
  return bus.connecting;
}

export async function subscribe(meetingId: string, fn: Listener): Promise<() => void> {
  await ensureListening();
  let set = bus.listeners.get(meetingId);
  if (!set) bus.listeners.set(meetingId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) bus.listeners.delete(meetingId);
  };
}

export function canReceive(audience: Audience, viewer: { moderator: boolean; key: string | null }): boolean {
  if (audience === "all") return true;
  if (audience === "moderators") return viewer.moderator;
  return viewer.moderator || audience === viewer.key;
}

export async function closeBus(): Promise<void> {
  const c = bus.client;
  bus.client = null;
  bus.listeners.clear();
  if (c) await c.end().catch(() => {});
}
