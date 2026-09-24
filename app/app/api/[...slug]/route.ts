import { handleApi } from "@/webapp/api_routes";
import "@/webapp/feature_routes";
import "@/webapp/admin_routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function handler(req: Request, ctx: { params: Promise<{ slug: string[] }> }) {
  const { slug } = await ctx.params;
  return handleApi(req, slug.join("/"));
}

export { handler as GET, handler as POST, handler as PATCH, handler as PUT, handler as DELETE };
