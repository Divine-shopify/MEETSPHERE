import { notFound } from "@/lib/errors";
import { route } from "@/lib/http";
import { deletePreset, presetSchema, savePreset } from "@/lib/presets";

type P = { id: string };
const check = (id: string) => {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound("Preset not found");
};

export const PUT = route<P>(async (ctx, { id }) => {
  check(id);
  const { user } = await ctx.requireUser();
  const p = await savePreset(user.id, await ctx.json(presetSchema), id);
  return { preset: { id: p.id, name: p.name } };
});

export const DELETE = route<P>(async (ctx, { id }) => {
  check(id);
  const { user } = await ctx.requireUser();
  await deletePreset(user.id, id);
  return { ok: true };
});
