// icourse163.org (课程平台) protocol client.
// Reverse-engineered request formats:
//   - signed write : POST /web/j/courseRpcBean.saveMocContentLearn.rpc?csrfKey=...
//     headers: edu-script-token, Timestamp(ms), Nonce(1000-9999), System:v1,
//              Auth-Signature = UPPER(MD5(body + Nonce + Timestamp + SECRET))
//   - unsigned read: POST /web/j/courseBean.*.rpc  (x-www-form-urlencoded)
//   - DWR (no signature): POST /dwr/call/plaincall/CourseBean.getLessonUnitLearnVo.dwr (text/plain)
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { chromium } from 'playwright-core';
import { sleep, buildQuizSession, sacrificedOptIds } from './human.mjs';

export const SIGN_SECRET = 'fu2s2kxcswgn5hqanx7asmlogyr5wu29';
export const DEFAULT_ORIGIN = process.env.MK163_ORIGIN || 'https://www.icourse163.org';

export function defaultAuthFile() {
  return process.env.MK163_AUTH_FILE || path.join(os.homedir(), '.mk163', 'auth.json');
}

export function tryJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// Evaluate a DWR reply (//#DWR-REPLY ... dwr.engine._remoteHandleCallback('batch','0',{...}))
// in a sandbox whose dwr.engine is a stub; returns the callback payload.
export function parseDwrReply(text) {
  const idx = text.indexOf('//#DWR-REPLY');
  const src = idx >= 0 ? text.slice(idx) : text;
  const captured = { callback: null, exception: null };
  const sandbox = {
    dwr: {
      engine: {
        _remoteHandleCallback: (...args) => {
          captured.callback = args[2];
        },
        _remoteHandleException: (...args) => {
          captured.exception = args;
        },
      },
    },
  };
  vm.runInNewContext(src, sandbox, { timeout: 3000 });
  if (captured.exception) throw new Error('DWR exception: ' + JSON.stringify(captured.exception));
  return captured.callback;
}

export class Icourse163Client {
  constructor(opts = {}) {
    this.authFile = opts.authFile || defaultAuthFile();
    this.origin = opts.origin || DEFAULT_ORIGIN;
    // Server enforces a concurrency limit on writes; keep >= 12s between signed writes.
    this.minIntervalMs = opts.minIntervalMs ?? Number(process.env.MK163_MIN_INTERVAL_MS || 13000);
    this._lastWriteAt = 0;
    this.auth = null;
    this._page = null;
    this._browser = null;
    this._transportPromise = null;
    this._memberId = null;
  }

  // The site's WAF rejects non-browser HTTP clients (Node fetch / curl / H2 all get
  // -1002 on authed rpc), so ALL API traffic is routed through a real headless
  // Chrome page that shares the logged-in session (storageState from saved cookies).
  async ensureTransport() {
    if (this._page && !this._page.isClosed()) return this._page;
    if (this._transportPromise) return this._transportPromise;
    this._transportPromise = (async () => {
      this._requireAuth();
      let browser;
      try {
        browser = await chromium.launch({ channel: 'chrome', headless: true });
      } catch {
        try {
          browser = await chromium.launch({ channel: 'msedge', headless: true });
        } catch {
          throw new Error('未找到本机 Chrome/Edge,无法启动传输浏览器');
        }
      }
      const context = await browser.newContext({
        storageState: { cookies: this.auth.cookies, origins: [] },
        userAgent: this.auth.userAgent || undefined,
        viewport: { width: 1280, height: 800 },
      });
      const page = await context.newPage();
      await page.goto(this.origin + '/', { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
      this._browser = browser;
      this._page = page;
      return page;
    })();
    try {
      return await this._transportPromise;
    } catch (e) {
      this._transportPromise = null;
      throw e;
    }
  }

  async resetTransport() {
    this._transportPromise = null;
    this._page = null;
    const b = this._browser;
    this._browser = null;
    if (b) await b.close().catch(() => {});
  }

  loadAuth() {
    try {
      this.auth = JSON.parse(fs.readFileSync(this.authFile, 'utf8'));
    } catch {
      this.auth = null;
    }
    return this.auth;
  }

  _requireAuth() {
    if (!this.auth) this.loadAuth();
    if (!this.auth || !Array.isArray(this.auth.cookies) || this.auth.cookies.length === 0) {
      throw new Error('未登录:请先调用 mk_login_start,在弹出的浏览器中登录一次以保存会话');
    }
  }

  get csrfKey() {
    if (!this.auth) this.loadAuth();
    const c = (this.auth?.cookies || []).find((x) => x.name === 'NTESSTUDYSI');
    return this.auth?.csrfKey || c?.value || '';
  }

  get userId() {
    if (!this.auth) this.loadAuth();
    const c = (this.auth?.cookies || []).find((x) => x.name === 'NTES_STUID');
    return this.auth?.userId || c?.value || null;
  }

  _cookieHeader() {
    const parts = (this.auth?.cookies || [])
      .filter((c) => (c.domain || '').includes('163.com'))
      .map((c) => `${c.name}=${c.value}`);
    return parts.join('; ');
  }

  async _throttle() {
    const wait = this._lastWriteAt + this.minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this._lastWriteAt = Date.now();
  }

  async _post(pathWithQuery, { headers = {}, body }) {
    this._requireAuth();
    const finalHeaders = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...headers,
    };
    await this.ensureTransport();
    if (this._page && !this._page.isClosed()) {
      // in-browser fetch: real TLS/fingerprint, cookies auto-attached, same-origin
      const res = await this._page.evaluate(async ({ path, headers: h, body: b }) => {
        const r = await fetch(path, { method: 'POST', headers: h, body: b, credentials: 'include' });
        return { status: r.status, text: await r.text() };
      }, { path: pathWithQuery, headers: finalHeaders, body });
      return { status: res.status, text: res.text, json: tryJson(res.text) };
    }
    const url = this.origin + pathWithQuery;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: this._cookieHeader(),
        'User-Agent': this.auth.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        Referer: this.origin + '/',
        Origin: this.origin,
        ...finalHeaders,
      },
      body,
    });
    const text = await res.text();
    return { status: res.status, text, json: tryJson(text) };
  }

  // Unsigned form RPC (reads): e.g. rpcForm('courseBean.getLastLearnedMocTermDto', {termId})
  async rpcForm(beanMethod, formObj) {
    const body = new URLSearchParams(formObj).toString();
    return this._post(`/web/j/${beanMethod}.rpc?csrfKey=${this.csrfKey}`, {
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });
  }

  // Signed JSON RPC (writes). Throttled to minIntervalMs. Body = {"dto": ...}
  async rpcSigned(dto, rpcMethod = 'courseRpcBean.saveMocContentLearn') {
    return this.rpcSignedRaw(JSON.stringify({ dto }), rpcMethod);
  }

  // Signed post with a pre-built body string (e.g. submitAnswers' {"paperDto":...}).
  async rpcSignedRaw(bodyStr, rpcMethod) {
    await this._throttle();
    const nonce = String(1000 + Math.floor(Math.random() * 9000));
    const ts = String(Date.now());
    const sig = crypto
      .createHash('md5')
      .update(bodyStr + nonce + ts + SIGN_SECRET, 'utf8')
      .digest('hex')
      .toUpperCase();
    return this._post(`/web/j/${rpcMethod}.rpc?csrfKey=${this.csrfKey}`, {
      body: bodyStr,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'edu-script-token': this.csrfKey,
        Timestamp: ts,
        Nonce: nonce,
        System: 'v1',
        'Auth-Signature': sig,
      },
    });
  }

  // DWR content fetch: contentType 3=doc(textPages/textUrl), 5=quiz(paper with leaked answers)
  async dwrGetLessonUnitLearnVo(contentId, contentType, unitId, isPreview = 0) {
    const body = [
      'callCount=1',
      'scriptSessionId=${scriptSessionId}190',
      `httpSessionId=${this.csrfKey}`,
      'c0-scriptName=CourseBean',
      'c0-methodName=getLessonUnitLearnVo',
      'c0-id=0',
      `c0-param0=number:${contentId}`,
      `c0-param1=number:${contentType}`,
      `c0-param2=number:${isPreview}`,
      `c0-param3=number:${unitId}`,
      `batchId=${Date.now()}`,
    ].join('\n');
    const { text } = await this._post('/dwr/call/plaincall/CourseBean.getLessonUnitLearnVo.dwr', {
      body,
      headers: { 'Content-Type': 'text/plain' },
    });
    return { raw: text, data: parseDwrReply(text) };
  }

  // ---------- high level ----------

  async getMocTermDto(termId) {
    const r = await this.rpcForm('courseBean.getMocTermDto', {
      termId: String(termId),
      isDraft: '0',
      excludeUnrelease: '0',
    });
    if (r.json?.code !== 0) throw new Error(`getMocTermDto failed: ${r.status} ${r.text.slice(0, 300)}`);
    return r.json.result;
  }

  async getLastLearnedTerm(termId) {
    const r = await this.rpcForm('courseBean.getLastLearnedMocTermDto', { termId: String(termId) });
    if (r.json?.code !== 0) throw new Error(`getLastLearnedMocTermDto failed: ${r.status} ${r.text.slice(0, 300)}`);
    const m = r.text.match(/"memberId":\s*(\d+)/);
    if (m) this._memberId = m[1];
    return r.json.result.mocTermDto;
  }

  // Recently-learned courses (the working set). mocCourseBaseCardVo carries
  // currentTermId = the tid every other tool needs.
  async listCourses() {
    const r = await this._post('/web/j/courseBean.getLastLearnCourse.rpc.rpc?csrfKey=' + this.csrfKey, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    if (r.json?.code !== 0) throw new Error(`getLastLearnCourse failed: ${r.status} ${r.text.slice(0, 200)}`);
    return (r.json.result || [])
      .map((it) => {
        const card = it.mocCourseBaseCardVo || {};
        return {
          termId: card.currentTermId ?? null,
          courseId: card.id ?? it.id ?? null,
          courseName: card.name ?? null,
          teacher: card.teacherName ?? null,
          school: card.schoolName ?? null,
          startTime: card.startTime ?? null,
          endTime: card.endTime ?? null,
          published: card.currentTermPubblishStatus === 2,
        };
      })
      .filter((x) => x.courseId);
  }

  // Flatten chapters -> lessons -> units with learn status attached.
  flattenUnits(mocTermDto) {
    const out = [];
    for (const ch of mocTermDto.chapters || []) {
      for (const ls of ch.lessons || []) {
        for (const u of ls.units || []) {
          out.push({
            chapterId: ch.id,
            chapterName: ch.name,
            chapterPublished: !!ch.published,
            lessonId: ls.id,
            lessonName: ls.name,
            unitId: u.id,
            name: u.name,
            contentType: u.contentType, // 1 video, 3 doc, 4 richtext, 5 quiz, 6 discussion
            contentId: u.contentId,
            durationInSeconds: u.durationInSeconds,
            viewStatus: u.viewStatus,
            completePercent: u.completePercent,
            anchorQuestions: (u.anchorQuestions || []).map((a) => ({ anchor: a.anchor, questionId: a.questionId })),
          });
        }
      }
    }
    return out;
  }

  // memberId source: the certified-rights endpoint returns it for any logged-in session.
  async resolveMemberId() {
    if (this._memberId) return this._memberId;
    const r = await this._post('/mm-course/web/j/mocTermCertifiedBean.getMemberCertifiedRights.rpc?csrfKey=' + this.csrfKey, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    const m = r.json?.result?.memberId;
    if (!m) throw new Error(`无法获取 memberId: ${r.status} ${r.text.slice(0, 200)}`);
    this._memberId = String(m);
    return this._memberId;
  }

  // contentType=1 video. videoId == unit.contentId; server clamps percent to max(videoTime)/duration.
  async completeVideo({ unitId, courseId, lessonId, videoId, termId, durationSeconds, videoTime, userId }) {
    const uid = userId || this._memberId || (await this.resolveMemberId());
    if (!uid) throw new Error('缺少 userId(无法从会话解析 memberId,请显式传入)');
    return this.rpcSigned({
      unitId,
      finished: true,
      index: 1,
      duration: 60000,
      courseId,
      lessonId,
      videoId,
      termId,
      userId: String(uid),
      contentType: 1,
      action: 'LEARN_TIME_COUNT',
      videoTime: Math.max(Number(videoTime) || 0, (Number(durationSeconds) || 0) + 50),
      learnedVideoTimeCount: 60,
    });
  }

  // contentType=3 doc. pageNum = total pages from dwrGetLessonUnitLearnVo(contentId,3,unitId).textPages
  async completeDoc({ unitId, courseId, lessonId, termId, pageNum }) {
    return this.rpcSigned({
      unitId,
      finished: true,
      contentType: 3,
      index: 1,
      pageNum,
      courseId,
      lessonId,
      termId,
      lastLearnTime: Date.now(),
      learnedVideoTimeCount: 5,
    });
  }

  // contentType 4 richtext / 5 quiz-unit / 6 discussion: opening marks completion.
  async completeLearnInfo({ unitId, contentType }) {
    return this.rpcSigned({ unitId, finished: true, contentType });
  }

  // Quiz paper (contentType=5). Server includes correct answers: option.answer===true, stdAnswer.
  async getQuizPaper(contentId, unitId) {
    const { data } = await this.dwrGetLessonUnitLearnVo(contentId, 5, unitId);
    const paper = data?.paper || null;
    if (!paper) return { paper: null, raw: data };
    const strip = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    const questions = (paper.objectiveQList || []).map((q) => ({
      id: q.id,
      type: q.type, // 1 single, 2 multi, 4 judge
      title: strip(q.plainTextTitle || q.title || q.description).slice(0, 500),
      score: q.score,
      options: (q.optionDtos || []).map((o) => ({
        id: o.id,
        text: strip(o.content).slice(0, 200),
        isAnswer: o.answer === true,
      })),
      stdAnswer: q.stdAnswer ?? null,
    }));
    return {
      paper: {
        tid: paper.tid,
        type: paper.type,
        autoSubmit: paper.autoSubmit,
        tryTime: paper.tryTime,
        usedTryCount: paper.usedTryCount,
        submitStatus: paper.submitStatus,
        questionCount: questions.length,
        questions,
      },
      subjectiveQList: paper.subjectiveQList || [],
    };
  }

  // contentType=6 discussion: unit only completes after a REAL reply (saveMocContentLearn alone returns code:0 but vs stays 0).
  // postId == unit.contentId from the tree. Verified: MocForumBean.addReply (DWR) -> vs=5/cp=1.
  async discussReply(postId, text, anonymous = 0) {
    const body = [
      'callCount=1',
      'scriptSessionId=${scriptSessionId}190',
      `httpSessionId=${this.csrfKey}`,
      'c0-scriptName=MocForumBean',
      'c0-methodName=addReply',
      'c0-id=0',
      `c0-e1=number:${postId}`,
      `c0-e2=string:${encodeURIComponent('<p>' + text + '</p>')}`,
      `c0-e3=number:${anonymous}`,
      'c0-param0=Object_Object:{postId:reference:c0-e1,content:reference:c0-e2,anonymous:reference:c0-e3}',
      'c0-param1=Array:[]',
      `batchId=${Date.now()}`,
    ].join('\n');
    const { text: raw } = await this._post('/dwr/call/plaincall/MocForumBean.addReply.dwr', {
      body,
      headers: { 'Content-Type': 'text/plain' },
    });
    const data = parseDwrReply(raw);
    if (!data || data.id === undefined) throw new Error('addReply 返回异常: ' + raw.slice(0, 200));
    return { ok: true, replierId: data.id };
  }

  // contentType=3 doc: fetch page count + textUrl, and DOWNLOAD the full PDF bytes
  // (CDN access log should match "actually opened it"). Call before completeDoc.
  async fetchDocPdf(contentId, unitId) {
    const { data } = await this.dwrGetLessonUnitLearnVo(contentId, 3, unitId);
    const url = data?.textUrl;
    const pdf = { status: null, bytes: 0 };
    if (url) {
      try {
        const res = await fetch(url, {
          headers: { Cookie: this._cookieHeader(), 'User-Agent': this.auth?.userAgent || 'Mozilla/5.0' },
        });
        pdf.status = res.status;
        const buf = await res.arrayBuffer(); // drain fully = real download
        pdf.bytes = buf.byteLength;
      } catch (e) {
        pdf.status = `error:${String(e).slice(0, 60)}`;
      }
    }
    return { textPages: data?.textPages, textUrl: url, pdf };
  }

  // Quiz submission as a realistic answering session:
  //   open (learn-info) -> q-by-q delays (5-6s base, length-scaled) with REAL
  //   timestamps -> a few deliberately wrong answers -> review gap -> submit.
  // wrongCount: 'auto' (~25%, 1..3) or an explicit number.
  // fillAnswers: { [qid]: text } for type-3 fill-in-blank questions — they are
  // submitted as content:{content:text} (no optIds; the server rejects optIds
  // answers for them with code:-1).
  async submitQuiz({ contentId, unitId, sessionSeconds = 45, wrongCount = 'auto', fillAnswers } = {}) {
    const { data } = await this.dwrGetLessonUnitLearnVo(contentId, 5, unitId);
    const paper = data?.paper;
    if (!paper || !paper.objectiveQList?.length) throw new Error('未取到试卷 objectiveQList');
    const sess = buildQuizSession(paper, { sessionSeconds, wrongCount });
    const startedAt = Date.now();
    await this.rpcSigned({ unitId, finished: true, contentType: 5 }); // "opening" the quiz
    const fa = fillAnswers || {};
    const answers = [];
    const sacrificed = [];
    for (let i = 0; i < sess.qs.length; i++) {
      await sleep(sess.delays[i]);
      const q = sess.qs[i];
      if (q.type === 3) {
        // fill-in-blank: text answer, no optIds
        answers.push({ qid: q.id, type: q.type, content: { content: String(fa[q.id] ?? '') } });
        continue;
      }
      let optIds = (q.optionDtos || []).filter((o) => o.answer === true).map((o) => o.id);
      if (!optIds.length) optIds = (q.optionDtos || []).map((o) => o.id).slice(0, 1);
      if (sess.sacrificeIdx.has(i)) {
        optIds = sacrificedOptIds(q);
        sacrificed.push(q.id);
      }
      answers.push({ qid: q.id, type: q.type, optIds, time: Date.now() });
    }
    await sleep(sess.reviewMs);
    // the site submits the FULL paper dto (serialized) with answers attached;
    // NOTE: top-level {"paperDto":..., "preview":false} — NOT wrapped in {"dto":...}
    const dto = JSON.parse(JSON.stringify(paper));
    dto.submitStatus = 1;
    dto.answers = answers;
    const r = await this.rpcSignedRaw(
      JSON.stringify({ paperDto: dto, preview: false }),
      'mocQuizRpcBean.submitAnswers',
    );
    if (r.json?.code !== 0 || r.json?.result === -1) throw new Error(`交卷失败: ${r.status} ${r.text.slice(0, 200)}`);
    return {
      aid: paper.aid,
      tid: paper.tid,
      questionCount: answers.length,
      wrongAnswers: sacrificed.length,
      sacrificedQids: sacrificed,
      sessionMs: Date.now() - startedAt,
      submit: r.json,
    };
  }
}
