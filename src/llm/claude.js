import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente Claude singleton con prompt caching agresivo.
 *
 * Env:
 *   ANTHROPIC_API_KEY — requerido para usar LLM
 *   CLAUDE_MODEL      — default "claude-haiku-4-5" (rápido + barato)
 */

let client = null;

// rate limiting: tier 1 Anthropic = 50k input tokens/min.
// serializamos llamadas y tracking de tokens en ventana deslizante.
const TOKEN_WINDOW_MS = 60_000;
const TOKEN_BUDGET = Number(process.env.CLAUDE_TPM_BUDGET) || 40000; // margen 80% del limite 50k
const recentTokens = []; // [{ ts, tokens }]
let lastCallEnded = 0;
const MIN_GAP_MS = Number(process.env.CLAUDE_MIN_GAP_MS) || 1500;

async function waitForTokenBudget(estimatedTokens = 0) {
  // mínimo gap entre requests (suave para no stampede)
  const sinceLast = Date.now() - lastCallEnded;
  if (sinceLast < MIN_GAP_MS) {
    await new Promise((r) => setTimeout(r, MIN_GAP_MS - sinceLast));
  }

  // purge ventana
  const now = Date.now();
  while (recentTokens.length && now - recentTokens[0].ts > TOKEN_WINDOW_MS) {
    recentTokens.shift();
  }

  const usedInWindow = recentTokens.reduce((a, b) => a + b.tokens, 0);
  const wouldExceed = usedInWindow + estimatedTokens > TOKEN_BUDGET;

  if (wouldExceed && recentTokens.length > 0) {
    // espera hasta que la entrada más vieja salga de la ventana
    const oldestTs = recentTokens[0].ts;
    const waitMs = TOKEN_WINDOW_MS - (now - oldestTs) + 500;
    console.log(`[claude] rate-limit guard: espero ${Math.round(waitMs / 1000)}s (budget ${usedInWindow}/${TOKEN_BUDGET} usado)`);
    await new Promise((r) => setTimeout(r, waitMs));
    // purge de nuevo
    const after = Date.now();
    while (recentTokens.length && after - recentTokens[0].ts > TOKEN_WINDOW_MS) {
      recentTokens.shift();
    }
  }
}

function recordTokenUsage(usage) {
  const total =
    (usage?.input_tokens || 0) +
    (usage?.cache_creation_input_tokens || 0);
  if (total) recentTokens.push({ ts: Date.now(), tokens: total });
  lastCallEnded = Date.now();
}

function getClient() {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error("ANTHROPIC_API_KEY no está en env");
  }
  client = new Anthropic({ apiKey, maxRetries: 3 });
  return client;
}

export function isLlmAvailable() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export function defaultModel() {
  return process.env.CLAUDE_MODEL || "claude-haiku-4-5";
}

/**
 * Llama al API con retry exponencial y control de errores transientes.
 *
 * @param {object} opts - igual que client.messages.create()
 * @returns {Promise<import('@anthropic-ai/sdk').Anthropic.Message>}
 */
export async function createMessage(opts) {
  const c = getClient();

  // heurística: tokens esperados basados en tamaño del content
  let estTokens = 500; // base
  for (const msg of opts.messages || []) {
    for (const block of (Array.isArray(msg.content) ? msg.content : [{ text: msg.content || "" }])) {
      if (block.type === "text" || typeof block.text === "string") {
        estTokens += Math.ceil((block.text || "").length / 4); // ~4 chars/token
      } else if (block.type === "document" && block.source?.data) {
        // PDF base64: 1500-3500 tokens/page; estimamos por tamaño (rough)
        const approxPages = Math.ceil(block.source.data.length / 40000); // muy rough
        estTokens += approxPages * 2500;
      }
    }
  }

  await waitForTokenBudget(estTokens);

  try {
    const msg = await c.messages.create({
      model: defaultModel(),
      max_tokens: 1024,
      ...opts,
    });
    recordTokenUsage(msg.usage);
    return msg;
  } catch (e) {
    const status = e?.status;
    if (status === 429) {
      // rate limit — lee header retry-after si está, si no backoff 60s
      const retryAfter = Number(e?.headers?.["retry-after"]) || 60;
      console.warn(`[claude] 429 rate-limit, esperando ${retryAfter}s antes de reintentar...`);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      const msg = await c.messages.create({
        model: defaultModel(),
        max_tokens: 1024,
        ...opts,
      });
      recordTokenUsage(msg.usage);
      return msg;
    }
    if (status === 529) {
      // sobrecarga — espera y reintenta una vez más
      await new Promise((r) => setTimeout(r, 5000));
      const msg = await c.messages.create({
        model: defaultModel(),
        max_tokens: 1024,
        ...opts,
      });
      recordTokenUsage(msg.usage);
      return msg;
    }
    throw e;
  }
}

/**
 * Extrae contenido de texto de un mensaje Claude (ignora tool_use, etc).
 */
export function extractText(message) {
  if (!message?.content) return "";
  return message.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

/**
 * Invoca al API esperando tool_use con input estructurado.
 * Retorna el input JSON de la tool, o null si no hubo tool_use.
 */
export function extractToolInput(message, toolName) {
  if (!message?.content) return null;
  const tool = message.content.find((b) => b.type === "tool_use" && b.name === toolName);
  return tool?.input || null;
}
