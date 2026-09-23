import * as A from "@/services/actions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Vercel Cron, daily (vercel.json). Authorization: Bearer $CRON_SECRET. */
export async function GET(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) return new Response(null, { status: 401 });
  const r = await A.run(() => A.cleanup());
  return Response.json(r);
}
