#!/usr/bin/env node
// mk-mcp: generic MCP server for icourse163.org (课程平台).
// Tools are course-agnostic; all ids are passed in per call.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Icourse163Client, defaultAuthFile } from './client.mjs';
import { loginStart, loginState, loginCancel } from './login.mjs';
import { sleep, gauss } from './human.mjs';

const client = new Icourse163Client();

function text(result) {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

function mapWithRetry(items, fn, retries = 1) {
  return items.reduce(
    (chain, item) =>
      chain.then(async (acc) => {
        let lastErr;
        for (let i = 0; i <= retries; i++) {
          try {
            acc.push({ ...item, result: await fn(item) });
            return acc;
          } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 20000)); // concurrency-limit cool-down
          }
        }
        acc.push({ ...item, error: String(lastErr?.message || lastErr) });
        return acc;
      }),
    Promise.resolve([]),
  );
}

const server = new McpServer({ name: 'mk-mcp', version: '0.1.0' });

server.registerTool(
  'mk_login_start',
  {
    title: 'MK 登录',
    description:
      '拉起本机 Chrome/Edge 打开登录页,由用户手动登录 icourse163.org(课程平台)。本调用立即返回;成功后自动抓取全部 cookie(含 HttpOnly)和该浏览器的 UA 存盘。用 mk_login_status 轮询结果。',
    inputSchema: {
      timeoutSeconds: z.number().int().min(30).max(900).default(300).describe('后台轮询登录的最长时间'),
      termId: z
        .union([z.string(), z.number()])
        .optional()
        .describe('课程页 tid;提供后以鉴权接口实测 code:0 作为登录成功判据(强烈建议)'),
    },
  },
  async ({ timeoutSeconds, termId }) =>
    text(await loginStart({ authFile: defaultAuthFile(), timeoutMs: timeoutSeconds * 1000, termId })),
);

server.registerTool(
  'mk_login_status',
  {
    title: 'MK 登录状态',
    description: '查询浏览器登录流程状态: idle/running/success/failed/timeout/cancelled。running 时提示用户到弹出的浏览器窗口完成验证码或扫码。',
    inputSchema: {},
  },
  async () => text(loginState()),
);

server.registerTool(
  'mk_login_cancel',
  {
    title: 'MK 取消登录',
    description: '关闭登录浏览器并取消进行中的登录流程。',
    inputSchema: {},
  },
  async () => text(await loginCancel()),
);

server.registerTool(
  'mk_check_login',
  {
    title: 'MK 登录态检查',
    description: '检查本地保存的会话是否有效;给 termId 时会实际调用鉴权接口验证。',
    inputSchema: { termId: z.union([z.string(), z.number()]).optional().describe('学期/班级 id(tid),可选') },
  },
  async ({ termId }) => {
    const auth = client.loadAuth();
    if (!auth) return text({ loggedIn: false, reason: '无本地会话,请先 mk_login_start' });
    if (!termId) {
      const memberId = await client.resolveMemberId().catch(() => null);
      return text({ loggedIn: true, hasCookies: true, memberId, csrfKey: client.csrfKey, savedAt: auth.savedAt });
    }
    const tree = await client.getLastLearnedTerm(termId);
    const memberId = client._memberId || (await client.resolveMemberId().catch(() => null));
    return text({ loggedIn: true, courseName: tree.courseName, courseId: tree.courseId, memberId });
  },
);

server.registerTool(
  'mk_list_courses',
  {
    title: 'MK 课程列表',
    description:
      '列出当前账号最近学习的课程(含 termId/教师/学校/起止时间/发布状态)。各工具要的 tid 直接从这里拿;若目标课程不在列表里,提供课程页 URL 里的 tid 也可以。',
    inputSchema: {},
  },
  async () => text({ courses: await client.listCourses() }),
);

server.registerTool(
  'mk_get_course',
  {
    title: 'MK 课程结构',
    description: '获取课程完整结构:章(chapters)→节(lessons)→任务点(units),含类型/完成度/发布状态。',
    inputSchema: { termId: z.union([z.string(), z.number()]).describe('学期 id(tid)') },
  },
  async ({ termId }) => {
    const tree = await client.getLastLearnedTerm(termId);
    const units = client.flattenUnits(tree);
    return text({
      termId: tree.id,
      courseId: tree.courseId,
      courseName: tree.courseName,
      chapterCount: (tree.chapters || []).length,
      unitCount: units.length,
      byType: units.reduce((m, u) => ((m[u.contentType] = (m[u.contentType] || 0) + 1), m), {}),
      chapters: (tree.chapters || []).map((c) => ({
        id: c.id,
        name: c.name,
        published: !!c.published,
        lessons: (c.lessons || []).map((l) => ({ id: l.id, name: l.name, unitCount: (l.units || []).length })),
      })),
    });
  },
);

server.registerTool(
  'mk_list_units',
  {
    title: 'MK 任务点清单',
    description: '列出课程全部任务点(可按类型/完成度过滤)。类型: 1=视频 3=文档 4=富文本 5=测验 6=讨论。',
    inputSchema: {
      termId: z.union([z.string(), z.number()]),
      contentType: z.number().int().optional(),
      onlyUnfinished: z.boolean().default(false),
      onlyPublished: z.boolean().default(true),
    },
  },
  async ({ termId, contentType, onlyUnfinished, onlyPublished }) => {
    const tree = await client.getLastLearnedTerm(termId);
    let units = client.flattenUnits(tree);
    if (onlyPublished) units = units.filter((u) => u.chapterPublished);
    if (contentType) units = units.filter((u) => u.contentType === contentType);
    if (onlyUnfinished) units = units.filter((u) => (u.completePercent ?? 0) < 1);
    return text({ count: units.length, units });
  },
);

server.registerTool(
  'mk_complete_unit',
  {
    title: 'MK 完成单个任务点',
    description:
      '上报一个任务点的学习完成。视频(ct=1)一次上报 videoTime=时长+50 即 100%;文档(ct=3)需 textPages(可传 contentId 自动取);富文本/讨论(ct=4/6)打开即完成。',
    inputSchema: {
      termId: z.union([z.string(), z.number()]),
      courseId: z.union([z.string(), z.number()]),
      lessonId: z.union([z.string(), z.number()]),
      unitId: z.union([z.string(), z.number()]),
      contentType: z.number().int().describe('1视频 3文档 4富文本 5测验 6讨论'),
      contentId: z.union([z.string(), z.number()]).optional().describe('ct=1 时为 videoId;ct=3 时用于自动取总页数'),
      durationSeconds: z.number().optional().describe('ct=1 视频时长(秒)'),
      textPages: z.number().int().optional().describe('ct=3 文档总页数;不传且给了 contentId 时自动获取'),
    },
  },
  async (args) => {
    const { termId, courseId, lessonId, unitId, contentType, contentId, durationSeconds, textPages } = args;
    let r;
    let pdf = null;
    if (contentType === 1) {
      r = await client.completeVideo({ unitId, courseId, lessonId, videoId: contentId, termId, durationSeconds });
    } else if (contentType === 3) {
      // download the full PDF bytes first so the CDN log matches "opened the doc"
      const doc = contentId ? await client.fetchDocPdf(contentId, unitId) : { textPages, pdf: null };
      pdf = doc.pdf;
      const pageNum = textPages || doc.textPages;
      if (!pageNum) throw new Error('缺少文档总页数:请传 textPages 或 contentId');
      r = await client.completeDoc({ unitId, courseId, lessonId, termId, pageNum });
    } else {
      r = await client.completeLearnInfo({ unitId, contentType });
    }
    if (r.json?.code !== 0) throw new Error(`上报失败: ${r.status} ${r.text.slice(0, 300)}`);
    return text({ ok: true, unitId, contentType, pdf, resp: r.json });
  },
);

server.registerTool(
  'mk_complete_course',
  {
    title: 'MK 批量完成课程',
    description:
      '批量完成任务点:视频(ct1)一次上报;文档(ct3)自动下载 PDF 字节再上报;富文本(ct4)打开即完成;测验(ct5)默认只写学习记录,autoQuiz=true 走拟真逐题作答(含故意错题);讨论(ct6)不代发——返回讨论清单,由你逐条用 mk_discuss_reply 撰写并回帖(每条间隔 ~30s 波动)。内置 ≥13s 写节流与限流重试。',
    inputSchema: {
      termId: z.union([z.string(), z.number()]),
      types: z.string().default('1,3,4,6').describe('逗号分隔 contentType 列表(1视频 3文档 4富文本 5测验 6讨论)'),
      onlyUnfinished: z.boolean().default(true),
      includeUnpublished: z.boolean().default(false),
      autoQuiz: z.boolean().default(false).describe('ct=5: 自动拟真交卷(逐题节奏+故意错题)'),
      dryRun: z.boolean().default(false),
    },
  },
  async ({ termId, types, onlyUnfinished, includeUnpublished, autoQuiz, dryRun }) => {
    const tree = await client.getLastLearnedTerm(termId);
    const courseId = tree.courseId;
    const wanted = new Set(
      String(types)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter(Boolean),
    );
    let units = client.flattenUnits(tree).filter((u) => wanted.has(u.contentType));
    if (!includeUnpublished) units = units.filter((u) => u.chapterPublished);
    if (onlyUnfinished) units = units.filter((u) => (u.completePercent ?? 0) < 1);
    // discussions are NOT auto-posted: the agent authors each reply via mk_discuss_reply
    const discussUnits = units.filter((u) => u.contentType === 6);
    const execUnits = units.filter((u) => u.contentType !== 6);

    if (dryRun)
      return text({
        plan: execUnits.length,
        discussions: discussUnits.map((u) => ({ unitId: u.unitId, postId: u.contentId, name: u.name })),
        units: execUnits.map((u) => ({ unitId: u.unitId, ct: u.contentType, name: u.name })),
      });

    const results = await mapWithRetry(execUnits, async (u) => {
      let r;
      if (u.contentType === 1) {
        r = await client.completeVideo({
          unitId: u.unitId,
          courseId,
          lessonId: u.lessonId,
          videoId: u.contentId,
          termId,
          durationSeconds: u.durationInSeconds,
        });
      } else if (u.contentType === 3) {
        const doc = u.contentId ? await client.fetchDocPdf(u.contentId, u.unitId) : {};
        r = await client.completeDoc({ unitId: u.unitId, courseId, lessonId: u.lessonId, termId, pageNum: doc.textPages });
      } else if (u.contentType === 5) {
        if (!autoQuiz) {
          r = await client.completeLearnInfo({ unitId: u.unitId, contentType: 5 });
        } else {
          r = await client.submitQuiz({ contentId: u.contentId, unitId: u.unitId });
        }
      } else {
        r = await client.completeLearnInfo({ unitId: u.unitId, contentType: u.contentType });
      }
      return { code: 0, detail: r };
    });
    return text({
      courseId,
      total: execUnits.length,
      ok: results.filter((x) => x.result).length,
      failed: results.filter((x) => x.error),
      discussions: discussUnits.map((u) => ({ unitId: u.unitId, postId: u.contentId, name: u.name })),
      hint: discussUnits.length
        ? '讨论需逐条用 mk_discuss_reply 回帖(text 由你根据话题撰写),每条间隔 ~30s 波动'
        : undefined,
    });
  },
);

server.registerTool(
  'mk_get_quiz',
  {
    title: 'MK 拉取测验试卷',
    description: '取随堂测验/考试试卷:题目、选项与正确答案(服务端 DTO 自带 option.answer=true 与 stdAnswer),可据此满分作答。',
    inputSchema: {
      contentId: z.union([z.string(), z.number()]).describe('测验单元的 contentId(试卷 id tid 同值)'),
      unitId: z.union([z.string(), z.number()]),
    },
  },
  async ({ contentId, unitId }) => text(await client.getQuizPaper(contentId, unitId)),
);

server.registerTool(
  'mk_submit_quiz',
  {
    title: 'MK 提交测验(拟真作答)',
    description:
      '按真实节奏交卷:先写"打开测验"学习记录,然后逐题作答(每题 5-6s 基准波动,题干长则延长、短则缩短,真实时间戳写入答卷),故意错几道(默认约 25%,1-3 题),留检查间隔后提交。sessionSeconds 控制整场压缩到多少秒内(适配 MCP 超时,节奏比例保持不变)。',
    inputSchema: {
      contentId: z.union([z.string(), z.number()]).describe('测验单元 contentId(=试卷 tid)'),
      unitId: z.union([z.string(), z.number()]),
      sessionSeconds: z.number().min(15).max(300).default(45).describe('整场作答压缩到的目标秒数'),
      wrongCount: z
        .union([z.string(), z.number()])
        .default('auto')
        .describe("故意做错的题数;'auto'=按 25%(1-3 题),或传数字(0=全对)"),
      fillAnswers: z
        .record(z.string(), z.string())
        .optional()
        .describe('填空题(type=3)的作答文本,键为 qid(可先 mk_get_quiz 看题);不传则留空提交'),
    },
  },
  async ({ contentId, unitId, sessionSeconds, wrongCount, fillAnswers }) =>
    text(await client.submitQuiz({ contentId, unitId, sessionSeconds, wrongCount, fillAnswers })),
);

server.registerTool(
  'mk_discuss_reply',
  {
    title: 'MK 讨论回帖',
    description:
      '在讨论单元发一条回复(MocForumBean.addReply, DWR)。讨论只有真实回帖才会置为完成。text 必须由你(agent)根据讨论话题撰写与主题相关的内容,不要用模板或占位文字。时间戳节奏由调用方控制:批量发帖时请在两次调用之间自行 sleep(建议 30s±10s 高斯波动,半天内摊完即可);也可传 pauseBeforeMs 让本调用内部先等待。',
    inputSchema: {
      postId: z.union([z.string(), z.number()]).describe('讨论单元的 contentId(即帖子 id)'),
      text: z.string().min(1).max(2000).describe('回复文本,由你根据讨论话题撰写'),
      anonymous: z.number().int().min(0).max(1).default(0),
      pauseBeforeMs: z.number().int().min(0).max(120000).default(0).describe('发送前内部等待毫秒数(0=不等,由 agent 控制节奏)'),
    },
  },
  async ({ postId, text: reply, anonymous, pauseBeforeMs }) => {
    if (pauseBeforeMs > 0) await sleep(Math.round(gauss(pauseBeforeMs, pauseBeforeMs * 0.3, pauseBeforeMs * 0.4, pauseBeforeMs * 1.6)));
    return text(await client.discussReply(postId, reply, anonymous));
  },
);

server.registerTool(
  'mk_verify',
  {
    title: 'MK 完成度核验',
    description: '重新拉取学习树,输出每个任务点的 completePercent 与汇总(未满 1 的单独列出)。',
    inputSchema: { termId: z.union([z.string(), z.number()]) },
  },
  async ({ termId }) => {
    const tree = await client.getLastLearnedTerm(termId);
    const units = client.flattenUnits(tree);
    const unfinished = units.filter((u) => u.chapterPublished && (u.completePercent ?? 0) < 1);
    return text({
      courseName: tree.courseName,
      total: units.length,
      complete: units.length - unfinished.length,
      unfinished: unfinished.map((u) => ({ unitId: u.unitId, ct: u.contentType, cp: u.completePercent, name: u.name })),
      units: units.map((u) => ({ unitId: u.unitId, ct: u.contentType, cp: u.completePercent, vs: u.viewStatus, name: u.name })),
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[mk-mcp] ready (auth: ${defaultAuthFile()})`);
