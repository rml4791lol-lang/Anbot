// Cost rates for the Usage panel: USD per 1M tokens, keyed by the ledger's model
// reference `provider/model` (the same ref the Usage view's `models[].key` carries).
//
// Every listed rate was read from the official pricing page named in `PRICE_SOURCES`
// for its provider, on `accessed` date. A model absent from `RATES` is unknown: the
// panel shows its tokens only and never an amount for it.
//
// What this table deliberately does NOT price (left unknown rather than guessed):
// - long-context / tiered surcharges above a context threshold;
//   Anthropic 1-hour cache writes (here cache write is priced at the 5-minute rate);
// - Batch, Fast, Priority, or regional data-residency discounts and uplifts;
// - providers and models not listed below, local-agent CLIs, and custom gateways.
// Prices change; refresh a rate against its source page before trusting a total.

// One provider's official pricing page and the date the rates below were read.
export const PRICE_SOURCES = {
  deepseek: {
    url: 'https://api-docs.deepseek.com/quick_start/pricing/',
    accessed: '2026-11-26',
    note: 'Peak-hour rates, USD per 1M tokens. Off-peak is half the peak rate.',
  },
  openai: {
    url: 'https://developers.openai.com/api/docs/pricing/',
    accessed: '2026-11-26',
    note: 'Standard tier, short context, USD per 1M tokens. Long-context surcharge above 272K input tokens is not priced.',
  },
  anthropic: {
    url: 'https://docs.anthropic.com/en/docs/about-claude/pricing',
    accessed: '2026-11-26',
    note: 'USD per 1M tokens. Cache write carries the 5-minute write rate; the 1-hour write rate is not split out in the ledger.',
  },
  xai: {
    url: 'https://docs.x.ai/docs/models',
    accessed: '2026-11-26',
    note: 'USD per 1M tokens, below the long-context threshold. The above-threshold tier is not priced.',
  },
  moonshotai: {
    url: 'https://www.kimi.com/resources/kimi-k3-pricing',
    accessed: '2026-11-26',
    note: 'USD per 1M tokens for the K3 API listing.',
  },
  'moonshotai-cn': {
    url: 'https://platform.kimi.com/docs/pricing/chat',
    accessed: '2026-11-26',
    note: 'USD per 1M tokens. The CN console lists CNY; this table carries the USD snapshot from the Kimi K3 USD listing.',
  },
  'kimi-coding': {
    url: 'https://platform.kimi.com/docs/pricing/chat',
    accessed: '2026-11-26',
    note: 'USD per 1M tokens, K3 coding-plan listing.',
  },
}

// { input, output, cacheRead, cacheWrite } in USD per 1M tokens.
const RATES = {
  // DeepSeek — source: api-docs.deepseek.com/quick_start/pricing/ (peak).
  'deepseek/deepseek-flash': { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 },
  // Legacy alias still accepted by the API; served and billed at the Flash price.
  'deepseek/deepseek-v4-flash': { input: 0.30, output: 1.20, cacheRead: 0.006, cacheWrite: 0 },
  'deepseek/deepseek-v4-pro': { input: 1.32, output: 3.96, cacheRead: 0.044, cacheWrite: 0 },

  // OpenAI — source: developers.openai.com/api/docs/pricing/ (Standard, short context).
  'openai/gpt-5.4': { input: 2.50, output: 15.00, cacheRead: 0.25, cacheWrite: 0 },
  'openai/gpt-5.4-pro': { input: 30.00, output: 180.00, cacheRead: 0, cacheWrite: 0 },

  // Anthropic — source: docs.anthropic.com/en/docs/about-claude/pricing (5m cache write).
  'anthropic/claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'anthropic/claude-opus-4-5-20251101': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'anthropic/claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.50, cacheWrite: 6.25 },
  'anthropic/claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-sonnet-4-5-20250929': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.30, cacheWrite: 3.75 },
  'anthropic/claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  'anthropic/claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },

  // xAI — source: docs.x.ai/docs/models (below the long-context threshold).
  'xai/grok-4.3': { input: 1.25, output: 2.50, cacheRead: 0.20, cacheWrite: 0 },

  // Moonshot / Kimi — source: kimi-k3-pricing and platform.kimi.com/docs/pricing/chat.
  'moonshotai/kimi-k3': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },
  'moonshotai-cn/kimi-k3': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },
  'kimi-coding/k3': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },
  'kimi-coding/k3-256k': { input: 3.00, output: 15.00, cacheRead: 0.30, cacheWrite: 0 },
}

// The rate for a model ref, or undefined when the model is not priced here.
export function priceFor(ref) {
  return typeof ref === 'string' ? RATES[ref] : undefined
}

// USD cost of one billed token set at a rate. `tokens` carries the raw ledger fields:
// input (cache miss), cacheRead, cacheWrite, output. Unknown rates cost nothing and
// the caller flags the group as unknown instead of showing an amount.
export function costOf(rate, tokens) {
  if (rate === undefined || rate === null) return 0
  const input = Number.isSafeInteger(tokens.input) ? tokens.input : 0
  const cacheRead = Number.isSafeInteger(tokens.cacheRead) ? tokens.cacheRead : 0
  const cacheWrite = Number.isSafeInteger(tokens.cacheWrite) ? tokens.cacheWrite : 0
  const output = Number.isSafeInteger(tokens.output) ? tokens.output : 0
  return (input * (rate.input ?? 0) + cacheRead * (rate.cacheRead ?? 0)
    + cacheWrite * (rate.cacheWrite ?? 0) + output * (rate.output ?? 0)) / 1_000_000
}
