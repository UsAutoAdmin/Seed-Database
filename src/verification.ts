import { getOpenAIApiKey, getAnthropicApiKey } from "./config.js";
import { updateSoldConfidence } from "./db.js";

export interface VerificationJob {
  id: string;
  nkw: string;
  titles: string[];
}

const queue: VerificationJob[] = [];
let workerRunning = false;
let workerStop = false;
let onConfidenceUpdate: ((id: string, confidence: number) => void) | null = null;

export function setOnConfidenceUpdate(cb: (id: string, confidence: number) => void): void {
  onConfidenceUpdate = cb;
}

const MAX_QUEUE = 5000;
const POLL_MS = 1500;
const OPENAI_MODEL = "gpt-4o-mini";
const ANTHROPIC_MODEL = "claude-haiku-4-5";

function buildPrompt(searchQuery: string, titles: string[]): string {
  return `You are evaluating eBay sold listing titles to see if they match the part search.

Search query (the part we are looking for): "${searchQuery.replace(/"/g, "'")}"

Listing titles from the sold results page:
${titles.map((t, i) => `${i + 1}. ${t.replace(/\n/g, " ")}`).join("\n")}

Many eBay searches return related but wrong parts (e.g. "transfer case" or "differential case" when searching "carrier case"). Rate confidence that these sold listings are actually the same part as the search query.

Reply with ONLY a JSON object, no other text: {"confidence": <number 0.0 to 1.0>}
- 1.0 = all or almost all titles clearly match the search (same part)
- 0.5 = mixed or ambiguous
- 0.0 = most/all titles are a different part (e.g. wrong type of case)`;
}

function parseConfidenceFromContent(content: string): number {
  const match = content.match(/\{\s*"confidence"\s*:\s*([\d.]+)\s*\}/);
  if (!match) throw new Error(`Could not parse confidence from: ${content.slice(0, 200)}`);
  const confidence = parseFloat(match[1]);
  if (Number.isNaN(confidence)) throw new Error(`Invalid confidence: ${match[1]}`);
  return Math.max(0, Math.min(1, confidence));
}

/**
 * Add a job to the verification queue (async LLM confidence check).
 * Drops if queue is full.
 */
export function enqueueVerification(job: VerificationJob): void {
  if (queue.length >= MAX_QUEUE) return;
  queue.push(job);
}

/** Anthropic Messages API — preferred when ANTHROPIC_API_KEY is set. */
async function getConfidenceViaAnthropic(searchQuery: string, titles: string[]): Promise<number> {
  const key = getAnthropicApiKey();
  if (!key) return -1;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 150,
      messages: [{ role: "user", content: buildPrompt(searchQuery, titles) }],
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Anthropic ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { content?: Array<{ type: string; text?: string }> };
  const text = data.content?.[0]?.type === "text" ? data.content[0].text?.trim() : undefined;
  if (!text) throw new Error("Empty Anthropic response");
  return parseConfidenceFromContent(text);
}

/** OpenAI chat completions — used when only OPENAI_API_KEY is set. */
async function getConfidenceViaOpenAI(searchQuery: string, titles: string[]): Promise<number> {
  const key = getOpenAIApiKey();
  if (!key) return -1;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [{ role: "user", content: buildPrompt(searchQuery, titles) }],
      max_tokens: 100,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`OpenAI ${res.status}: ${err}`);
  }

  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty OpenAI response");
  return parseConfidenceFromContent(content);
}

/** Use Anthropic if key set, else OpenAI. Returns -1 if no LLM key configured. */
async function getConfidence(searchQuery: string, titles: string[]): Promise<number> {
  if (getAnthropicApiKey()) return getConfidenceViaAnthropic(searchQuery, titles);
  if (getOpenAIApiKey()) return getConfidenceViaOpenAI(searchQuery, titles);
  return -1;
}

async function runWorker(): Promise<void> {
  while (!workerStop) {
    const job = queue.shift();
    if (!job) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      continue;
    }

    try {
      const confidence = await getConfidence(job.nkw, job.titles);
      if (confidence >= 0) {
        await updateSoldConfidence(job.id, confidence);
        onConfidenceUpdate?.(job.id, confidence);
        console.log(`[verify] ${job.id} confidence=${(confidence * 100).toFixed(0)}%`);
      } else {
        console.warn("[verify] No LLM key — confidence not written");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[verify] ${job.id} "${job.nkw.slice(0, 40)}..." — ${msg}`);
    }
  }
}

export function startVerificationWorker(): void {
  if (workerRunning) return;
  workerRunning = true;
  workerStop = false;
  runWorker().finally(() => {
    workerRunning = false;
  });
}

export function stopVerificationWorker(): void {
  workerStop = true;
}

export function getVerificationQueueLength(): number {
  return queue.length;
}
