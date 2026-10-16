import { maskContact } from "@/lib/contact";
import { route } from "@/lib/http";
import { mediaConfigured } from "@/lib/media";
import { channelModes } from "@/lib/messaging";
import { getUser } from "@/lib/session";

export const GET = route(async (ctx) => {
  const session = await ctx.session();
  const user = session?.user_id ? await getUser(session.user_id) : null;
  return {
    user: user ? { id: user.id, displayName: user.display_name } : null,
    verified: {
      phone: maskContact(session?.verified_phone ?? null),
      email: maskContact(session?.verified_email ?? null),
    },
    services: { verification: channelModes(), media: mediaConfigured() },
  };
});
