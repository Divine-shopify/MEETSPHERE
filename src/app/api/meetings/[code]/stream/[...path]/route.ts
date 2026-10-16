import { one } from "@/lib/db";
import { forbidden, notFound } from "@/lib/errors";
import { route } from "@/lib/http";
import { requireMeeting } from "@/lib/meetings";
import type { Artifact } from "@/lib/recording";
import { canViewReplay } from "@/lib/replay";
import { localFileResponse, presignedUrl, readText } from "@/lib/storage";
import { viewerFor } from "@/lib/viewer";

type P = { code: string; path: string[] };

const playlistCache = new Map<string, { at: number; body: string }>();

/**
 * HLS for large audiences. Live: any admitted participant. Afterwards: per
 * replay visibility. With S3, the playlist is rewritten to short-lived signed
 * segment URLs so segment traffic goes straight to the bucket/CDN.
 *   /stream/<artifactId>/live.m3u8 | index.m3u8 | <segment>
 */
export const GET = route<P>(async (ctx, { code, path }) => {
  const meeting = await requireMeeting(code);
  const [artifactId, file] = path;
  if (!artifactId || !file || path.length !== 2 || !/^[0-9a-f-]{36}$/.test(artifactId) || !/^[\w.-]+$/.test(file)) throw notFound("Not found");
  const a = await one<Artifact>("SELECT * FROM meeting_artifacts WHERE id = $1 AND meeting_id = $2 AND type = 'stream' AND status <> 'deleted'", [artifactId, meeting.id]);
  if (!a || !a.storage_key || !a.storage) throw notFound("Stream not found");

  const live = meeting.stream_artifact_id === a.id;
  const v = await viewerFor(ctx, meeting);
  const allowed = live ? v.kind !== "none" : await canViewReplay(ctx, meeting);
  if (!allowed) throw forbidden("You don't have access to this stream.");

  const key = `${a.storage_key}/${file}`;
  const isPlaylist = file.endsWith(".m3u8");
  if (a.storage === "local") return localFileResponse(key, ctx.req, { maxAge: isPlaylist ? 0 : 3600 });

  if (!isPlaylist) return Response.redirect(await presignedUrl(key, 3600), 302);
  // Cache the rewritten playlist briefly; thousands of viewers poll it every few seconds.
  const cached = playlistCache.get(key);
  let body = cached && Date.now() - cached.at < 2000 ? cached.body : null;
  if (!body) {
    const raw = await readText("s3", key);
    const lines = await Promise.all(
      raw.split("\n").map(async (line) => (line && !line.startsWith("#") ? presignedUrl(`${a.storage_key}/${line.trim()}`, 3600) : line)),
    );
    body = lines.join("\n");
    playlistCache.set(key, { at: Date.now(), body });
  }
  return new Response(body, { headers: { "Content-Type": "application/vnd.apple.mpegurl", "Cache-Control": "private, max-age=1" } });
});
