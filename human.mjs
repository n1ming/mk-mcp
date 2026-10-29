// Realism helpers for the mk MCP.
// Philosophy: content and pacing BETWEEN tool calls are the calling agent's job
// (it writes the discussion replies, it sleeps between calls); this module only
// adds realism INSIDE one call:
//   - quiz: q-by-q answer delays (5-6s base, longer for long questions, shorter for
//     short ones) + deliberate wrong answers ("适当错个几道")
//   - docs: full PDF byte download before reporting completion (see client)
export const rnd = (a, b) => a + Math.random() * (b - a);
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export function gauss(mean, sd, min, max) {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  const g = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.min(max, Math.max(min, mean + g * sd));
}

// Per-question thinking time: 5-6s base wobble, extended for long stems/options,
// shortened for short ones. Returns milliseconds.
export function questionDelayMs(q) {
  const text =
    String(q.plainTextTitle || q.title || q.description || '') +
    (q.optionDtos || []).map((o) => String(o.content || '')).join('');
  return clamp(5.5 + text.length / 60, 3, 25) * rnd(0.75, 1.35) * 1000;
}

// "适当错个几道": ~25% of questions, at least 1, at most 3 (0 when only 1 question).
export function autoWrongCount(qCount) {
  return qCount <= 1 ? 0 : clamp(Math.round(qCount * 0.25), 1, 3);
}

// Make one question WRONG while keeping the rest of the answer intact:
// prefer adding a wrong pick (multi/single), fall back to dropping one correct
// (all-correct multi), degenerate single-correct-single-option cannot miss.
export function sacrificedOptIds(q) {
  const opts = q.optionDtos || [];
  const right = opts.filter((o) => o.answer === true).map((o) => o.id);
  const wrong = opts.filter((o) => o.answer !== true).map((o) => o.id);
  if (wrong.length) return [...right, pick(wrong)];
  if (right.length > 1) return right.slice(0, -1);
  return right;
}

// Plan one quiz answering session.
// Delays are scaled to fit within sessionSeconds (MCP call timeout safety);
// the *relative* rhythm (long q slow, short q fast, ±35% wobble) is preserved.
export function buildQuizSession(paper, { sessionSeconds = 45, wrongCount = 'auto' } = {}) {
  const qs = paper.objectiveQList || [];
  const nWrong = wrongCount === 'auto' ? autoWrongCount(qs.length) : clamp(Number(wrongCount) || 0, 0, Math.max(0, qs.length - 1));
  // never sacrifice the first question (usually the gimme), keep sacrifices distinct
  const pool = qs.map((_, i) => i).slice(1);
  const sacrificeIdx = new Set([...pool].sort(() => Math.random() - 0.5).slice(0, nWrong));
  const delays = qs.map((q) => questionDelayMs(q));
  const reviewMs = rnd(8000, 45000);
  const totalBase = delays.reduce((a, b) => a + b, 0) + reviewMs;
  const scale = Math.min(1, (sessionSeconds * 1000) / Math.max(1, totalBase));
  return { qs, delays: delays.map((d) => d * scale), reviewMs: reviewMs * scale, sacrificeIdx };
}
