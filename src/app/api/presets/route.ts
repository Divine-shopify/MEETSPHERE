import { route } from "@/lib/http";
import { listPresets, presetSchema, savePreset } from "@/lib/presets";

export const GET = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const presets = await listPresets(user.id);
  return {
    presets: presets.map((p) => ({ id: p.id, name: p.name, orgId: p.org_id, mine: p.owner_user_id === user.id, settings: p.settings, invitationCount: p.invitations.length })),
  };
});

export const POST = route(async (ctx) => {
  const { user } = await ctx.requireUser();
  const p = await savePreset(user.id, await ctx.json(presetSchema));
  return Response.json({ preset: { id: p.id, name: p.name } }, { status: 201 });
});
