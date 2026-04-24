import Anthropic from "@anthropic-ai/sdk";

/**
 * Cliente Claude singleton con prompt caching agresivo.
 *
 * Env:
 *   ANTHROPIC_API_KEY — requerido para usar LLM
 *   CLAUDE_MODEL      — default "claude-haiku-4-5" (rápido + barato)
 */

let client = null;

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
  try {
    return await c.messages.create({
      model: defaultModel(),
      max_tokens: 1024,
      ...opts,
    });
  } catch (e) {
    const status = e?.status;
    if (status === 429 || status === 529) {
      // sobrecarga — espera y reintenta una vez más manualmente
      await new Promise((r) => setTimeout(r, 2000));
      return c.messages.create({
        model: defaultModel(),
        max_tokens: 1024,
        ...opts,
      });
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
