/**
 * Thin OpenRouter chat helper shared by the marketing-copy translators
 * (translate-titles, translate-store-copy). Uses the same OPENROUTER_API_KEY
 * the project's other generation tooling reads. No SDK — just `fetch`.
 *
 * The model is overridable via OPENROUTER_MODEL; the default is a capable,
 * cheap model that handles short marketing strings across our locales well.
 */
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6"

export function requireApiKey(): string {
  const key = process.env.OPENROUTER_API_KEY
  if (!key) {
    throw new Error(
      "OPENROUTER_API_KEY is not set. Export it (e.g. OPENROUTER_API_KEY) before running the translator."
    )
  }
  return key
}

/** Send a single user prompt, return the assistant's text. */
export async function complete(prompt: string, opts: { temperature?: number } = {}): Promise<string> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${requireApiKey()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL,
      temperature: opts.temperature ?? 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`)
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  const text = json.choices?.[0]?.message?.content?.trim()
  if (!text) throw new Error(`Empty completion: ${JSON.stringify(json)}`)
  return text
}

/** Strip ```json fences a model may wrap a JSON answer in, then parse. */
export function parseJsonReply<T>(text: string): T {
  const cleaned = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim()
  return JSON.parse(cleaned) as T
}
