/**
 * services/llm_client.ts: OpenRouter transport. Lifted from finance-tracker
 * llm_service.ts (retry on 429/5xx honouring Retry-After, timeouts, JSON
 * extraction, token usage), without any finance context.
 */

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";
export const TEXT_MODEL = process.env.LLM_TEXT_MODEL || "openai/gpt-oss-20b";
export const IMAGE_MODEL = process.env.LLM_IMAGE_MODEL || "google/gemma-4-26b-a4b-it";

/**
 * OpenRouter provider routing. "latency" by default: the same model on a slow
 * provider took 15s for an 80-token reply, under 2s on the fastest one.
 * LLM_PROVIDER_SORT=throughput|price picks another order, "off" leaves it to OpenRouter.
 */
function _routing(): Dict {
  const sort = process.env.LLM_PROVIDER_SORT || "latency";
  return sort === "off" ? {} : { provider: { sort } };
}

export interface Usage {
  model: string;
  prompt_tokens: number;
  completion_tokens: number;
}

export class AiUnavailable extends Error {}

type Dict = Record<string, any>;

function _key(): string {
  const k = process.env.LLM_API_KEY;
  if (!k) throw new AiUnavailable("LLM_API_KEY is not set");
  return k;
}

const _sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function _delay(resp: Response | null): number {
  let s = 0.5;
  const ra = resp?.status === 429 ? Number(resp.headers.get("Retry-After")) : NaN;
  if (!Number.isNaN(ra)) s = ra;
  return Math.min(Math.max(s, 0.5), 5) * 1000;
}

async function _post(payload: Dict, timeoutMs: number): Promise<Dict> {
  const headers = {
    Authorization: `Bearer ${_key()}`,
    "Content-Type": "application/json",
    "X-Title": "Split Bill",
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    let resp: Response;
    try {
      resp = await fetch(OPENROUTER, { method: "POST", headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      if (attempt === 0) {
        await _sleep(_delay(null));
        continue;
      }
      throw e;
    }
    if (![429, 500, 502, 503, 504].includes(resp.status) || attempt === 1) {
      if (!resp.ok) throw Object.assign(new Error(`HTTP ${resp.status}`), { status: resp.status });
      return (await resp.json()) as Dict;
    }
    await _sleep(_delay(resp));
  }
  throw new Error("unreachable");
}

function _content(message: Dict): string {
  let c = message?.content ?? "";
  if (Array.isArray(c)) c = c.filter((p: Dict) => p?.type === "text").map((p: Dict) => p.text ?? "").join("");
  return String(c).trim();
}

export function parseJson(raw: string): unknown {
  const cleaned = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  const i = cleaned.search(/[[{]/);
  if (i < 0) throw new SyntaxError("No JSON found");
  const tail = cleaned.slice(i);
  try {
    return JSON.parse(tail);
  } catch {
    // Trailing prose after the object: cut at the last closing brace.
    const j = Math.max(tail.lastIndexOf("}"), tail.lastIndexOf("]"));
    return JSON.parse(tail.slice(0, j + 1));
  }
}

async function _call(payload: Dict, timeoutMs: number): Promise<[string, Usage]> {
  const data = await _post(payload, timeoutMs);
  const usage: Usage = {
    model: String(payload.model),
    prompt_tokens: data.usage?.prompt_tokens ?? 0,
    completion_tokens: data.usage?.completion_tokens ?? 0,
  };
  const text = _content(data.choices?.[0]?.message ?? {});
  if (!text) throw new Error(`Empty content from ${payload.model}`);
  return [text, usage];
}

/**
 * Text -> JSON with a strict schema when the provider accepts one (falls back
 * to prompt-only JSON on a 4xx). A parse or shape failure is retried up to
 * twice, but only while the whole call is still quick (the web route has 60s).
 */
export async function textJson(system: string, user: string, opts: { schema?: Dict; maxTokens?: number; timeoutMs?: number; validate?: (p: any) => boolean } = {}): Promise<[any, Usage]> {
  const timeoutMs = opts.timeoutMs ?? 45000;
  const payload: Dict = {
    model: TEXT_MODEL,
    max_tokens: opts.maxTokens ?? 2000,
    temperature: 0,
    reasoning: { effort: "low" },
    ..._routing(),
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
  };
  if (opts.schema) payload.response_format = { type: "json_schema", json_schema: { name: "bill", strict: true, schema: opts.schema } };
  let last: unknown = null;
  const t0 = Date.now();
  for (let i = 0; i < 3 && (i === 0 || Date.now() - t0 < 20000); i++) {
    try {
      let raw: string, usage: Usage;
      try {
        [raw, usage] = await _call(payload, timeoutMs);
      } catch (e: any) {
        if (payload.response_format && e.status >= 400 && e.status < 500) {
          delete payload.response_format;
          [raw, usage] = await _call(payload, timeoutMs);
        } else throw e;
      }
      const parsed = parseJson(raw);
      if (opts.validate && !opts.validate(parsed)) throw new Error("shape");
      return [parsed, usage];
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** One image + text -> JSON (vision model; prompt-only JSON). */
export async function imageJson(system: string, image: { b64: string; mime: string }, text: string, opts: { maxTokens?: number; validate?: (p: any) => boolean } = {}): Promise<[any, Usage]> {
  const payload: Dict = {
    model: IMAGE_MODEL,
    max_tokens: opts.maxTokens ?? 3000,
    temperature: 0,
    ..._routing(),
    messages: [
      { role: "system", content: system },
      { role: "user", content: [{ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.b64}` } }, { type: "text", text }] },
    ],
  };
  let last: unknown = null;
  // The web route has 60s: one try may take 50s, a retry only if the first failed fast.
  const t0 = Date.now();
  for (let i = 0; i < 2 && (i === 0 || Date.now() - t0 < 15000); i++) {
    try {
      const [raw, usage] = await _call(payload, 50000);
      const parsed = parseJson(raw);
      if (opts.validate && !opts.validate(parsed)) throw new Error("shape");
      return [parsed, usage];
    } catch (e) {
      last = e;
    }
  }
  throw last;
}

/** Downscale to 1600px on the long side, JPEG q85: enough for receipt text. */
export async function normalizeImage(bytes: Uint8Array, mime: string): Promise<{ bytes: Uint8Array; mime: string }> {
  try {
    const { createCanvas, loadImage } = await import("@napi-rs/canvas");
    const img = await loadImage(Buffer.from(bytes));
    const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(w, h);
    canvas.getContext("2d").drawImage(img as any, 0, 0, w, h);
    return { bytes: new Uint8Array(canvas.toBuffer("image/jpeg", 85)), mime: "image/jpeg" };
  } catch {
    return { bytes, mime };
  }
}
