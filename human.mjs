// Realism helpers for the icourse163 MCP.
// Philosophy: pacing BETWEEN tool calls is the calling agent's job (it can sleep);
// this module only adds realism INSIDE one call:
//   - quiz: q-by-q answer delays (5-6s base, longer for long questions, shorter for
//     short ones) + deliberate wrong answers ("适当错个几道")
//   - docs: full PDF byte download before reporting completion
//   - discussions: text pool (quality irrelevant; timestamps are the agent's concern)
export const rnd = (a, b) => a + Math.random() * (b - a);
export const ri = (a, b) => Math.floor(rnd(a, b + 1));
export const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
export const chance = (p) => Math.random() < p;
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

// Discussion text pool (content quality explicitly not a goal; agent controls timing).
const topic = (name) =>
  String(name || '该话题')
    .replace(/(讨论题?|[?？!！。])/g, '')
    .trim()
    .slice(0, 24) || '该话题';

const REPLY_TEMPLATES = [
  (t) => `学习「${t}」这一节后收获很大。我的理解是，遇到这类问题可以先发散列出尽量多的可能性，再用可行性和价值两个维度做收敛筛选。`,
  (t) => `关于${t}，结合自己的经历谈一点体会：很多看似常规的问题换个角度拆解，往往就能找到改进空间，关键是先把想法落下来再逐步验证。`,
  (t) =>
    `我的看法是${t}没有唯一标准答案，重要的是从不同视角审视。${
      chance(0.5) ? '课程里提到的方法给了我不少启发，准备在接下来的学习里实际试一试。' : '欢迎大家补充不同的思路。'
    }`,
  (t) => `本节关于${t}的内容让我意识到，很多结论并非凭空而来，往往来自对日常细节的重新审视和资源的重新组合。`,
  (t) => `${t}这个话题很有意思。我认为实践比空谈更重要，先小范围试错、快速拿到反馈，再决定是否放大投入。`,
];

export const draftReply = (unitName) => pick(REPLY_TEMPLATES)(topic(unitName));
