import { config } from "@/lib/config";
import { HttpError } from "@/lib/errors";
import { route } from "@/lib/http";
import { finishSso } from "@/lib/sso";

export const GET = route(async (ctx) => {
  const params = new URL(ctx.req.url).searchParams;
  const fail = (msg: string) => new Response(null, { status: 302, headers: { Location: `${config.baseUrl}/signin?sso_error=${encodeURIComponent(msg)}` } });
  if (params.get("error")) return fail(params.get("error_description") ?? "Sign-in was cancelled.");
  const session = await ctx.session();
  if (!session || !params.get("state") || !params.get("code")) return fail("This sign-in link expired. Start again.");
  try {
    const r = await finishSso(session, params.get("state")!, params.get("code")!);
    ctx.replaceSessionToken(r.token, { ...session, user_id: r.userId });
    return new Response(null, { status: 302, headers: { Location: `${config.baseUrl}${r.next}` } });
  } catch (err) {
    if (err instanceof HttpError) return fail(err.message);
    throw err;
  }
});
