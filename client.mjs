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
    this._stableUrl = null;
    this._slugByCourse = {};
    this._lastCookieSync = 0;
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
      const launchArgs = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];
      try {
        browser = await chromium.launch({ channel: 'chrome', headless: true, args: launchArgs });
      } catch {
        try {
          browser = await chromium.launch({ channel: 'msedge', headless: true, args: launchArgs });
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
      await new Promise((r) => setTimeout(r, 6000)); // let the homepage finish its own redirects
      this._browser = browser;
      this._page = page;
      this._stableUrl = page.url();
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

  // Periodically write the LIVE cookie jar back to auth.json so a server restart
  // can resume the still-valid session (login cookies expire server-side in hours;
  // a stale auth.json restores a logged-out context).
  async syncCookiesToFile() {
    if (!this._page || this._page.isClosed()) return;
    if (this._lastCookieSync && Date.now() - this._lastCookieSync < 600000) return;
    this._lastCookieSync = Date.now();
    try {
      const cookies = await this._page.context().cookies([
        'https://www.icourse163.org',
        'https://icourse163.org',
        'https://www.163.com',
        'https://study.163.com',
      ]);
      if (!cookies.length) return;
      this.auth.cookies = cookies;
      this.auth.csrfKey = cookies.find((x) => x.name === 'NTESSTUDYSI')?.value || this.auth.csrfKey;
      this.auth.savedAt = Date.now();
      fs.mkdirSync(path.dirname(this.authFile), { recursive: true });
      fs.writeFileSync(this.authFile, JSON.stringify(this.auth, null, 2));
    } catch {}
  }

  // NTESSTUDYSI (csrfKey) rotates server-side; always prefer the value live in
  // the transport page's cookie jar over the one persisted at login time.
  async liveCsrfKey() {
    await this.ensureTransport();
    try {
      const v = await this._page.evaluate(() => (document.cookie.match(/NTESSTUDYSI=([^;]+)/) || [])[1] || null);
      if (v) {
        this.auth.csrfKey = v;
        return v;
      }
    } catch {}
    return this.csrfKey;
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
    const live = await this.liveCsrfKey().catch(() => null);
    if (live && pathWithQuery.includes('csrfKey=')) {
      pathWithQuery = pathWithQuery.replace(/csrfKey=[^&]+/, 'csrfKey=' + live);
    }
    if (this._page && !this._page.isClosed()) {
      // in-browser fetch: real TLS/fingerprint, cookies auto-attached, same-origin.
      // The page occasionally navigates itself (promos/redirects), destroying the
      // execution context mid-call — recover by re-loading the origin and retrying.
      const run = () =>
        this._page.evaluate(async ({ path, headers: h, body: b }) => {
          const r = await fetch(path, { method: 'POST', headers: h, body: b, credentials: 'include' });
          return { status: r.status, text: await r.text() };
        }, { path: pathWithQuery, headers: finalHeaders, body });
      let res;
      try {
        res = await run();
      } catch (e) {
        if (!/Execution context|context was destroyed|Target closed/i.test(String(e))) throw e;
        const back = this._stableUrl || this.origin + '/';
        await this._page.goto(back, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
        await new Promise((r) => setTimeout(r, 5000));
        res = await run();
      }
      try {
        this._stableUrl = this._page.url();
      } catch {}
      this.syncCookiesToFile().catch(() => {});
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
    const csrf = await this.liveCsrfKey();
    return this._post(`/web/j/${beanMethod}.rpc?csrfKey=${csrf}`, {
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
    const csrf = await this.liveCsrfKey();
    const nonce = String(1000 + Math.floor(Math.random() * 9000));
    const ts = String(Date.now());
    const sig = crypto
      .createHash('md5')
      .update(bodyStr + nonce + ts + SIGN_SECRET, 'utf8')
      .digest('hex')
      .toUpperCase();
    return this._post(`/web/j/${rpcMethod}.rpc?csrfKey=${csrf}`, {
      body: bodyStr,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'edu-script-token': csrf,
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
      `httpSessionId=${await this.liveCsrfKey()}`,
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

  // Anchor (in-video) questions for one video unit: DWR MocQuizBean.fetchQuestions
  // with a full unit-DTO clone as param0 (structure replicated line-for-line from
  // a real capture). The response leaks correct answers inside optionsDetail.
  async fetchAnchorQuestions({ unitId, gmtCreate, name, lessonId, chapterId, termId, videoId, durationInSeconds, completePercent = 1, learnTime = 0, contentType = 1, anchors }) {
    await this.ensureTransport();
    const csrf = await this.liveCsrfKey();
    const enc = (x) => encodeURIComponent(x);
    const now = Date.now();
    const anchorsJson = enc(JSON.stringify(anchors || []));
    const a0 = (anchors || [])[0] || { anchor: 0, questionId: 0 };
    const lines = [
      'callCount=1',
      'scriptSessionId=${scriptSessionId}190',
      `httpSessionId=${csrf}`,
      'c0-scriptName=MocQuizBean',
      'c0-methodName=fetchQuestions',
      'c0-id=0',
      `c0-e1=number:${unitId}`,
      `c0-e2=number:${gmtCreate ?? now}`,
      `c0-e3=number:${now}`,
      `c0-e4=string:${enc(String(name || ''))}`,
      'c0-e5=number:0',
      `c0-e6=number:${lessonId}`,
      `c0-e7=number:${chapterId}`,
      `c0-e8=number:${termId}`,
      'c0-e9=number:1',
      `c0-e10=number:${videoId}`,
      'c0-e11=null:null',
      'c0-e12=null:null',
      'c0-e13=number:0',
      `c0-e14=number:${durationInSeconds ?? 0}`,
      'c0-e15=null:null',
      'c0-e16=number:5',
      'c0-e17=null:null',
      'c0-e18=null:null',
      'c0-e19=null:null',
      'c0-e20=null:null',
      `c0-e23=number:${a0.anchor}`,
      `c0-e24=number:${a0.questionId}`,
      'c0-e25=null:null',
      'c0-e26=null:null',
      'c0-e22=Object_Object:{anchor:reference:c0-e23,questionId:reference:c0-e24,mocQuestionDto:reference:c0-e25,testId:reference:c0-e26}',
      'c0-e21=Array:[reference:c0-e22]',
      `c0-e27=string:${anchorsJson}`,
      'c0-e28=null:null',
      'c0-e29=null:null',
      'c0-e30=null:null',
      'c0-e31=null:null',
      `c0-e32=number:${completePercent}`,
      `c0-e33=number:${learnTime}`,
      'c0-e34=null:null',
      'c0-e35=null:null',
      'c0-e36=null:null',
      'c0-e37=null:null',
      'c0-e38=number:1',
      'c0-param0=Object_Object:{id:reference:c0-e1,gmtCreate:reference:c0-e2,gmtModified:reference:c0-e3,name:reference:c0-e4,position:reference:c0-e5,lessonId:reference:c0-e6,chapterId:reference:c0-e7,termId:reference:c0-e8,contentType:reference:c0-e9,contentId:reference:c0-e10,unitId:reference:c0-e11,live:reference:c0-e12,freePreview:reference:c0-e13,durationInSeconds:reference:c0-e14,learnCount:reference:c0-e15,viewStatus:reference:c0-e16,nameAlias:reference:c0-e17,photoUrl:reference:c0-e18,resourceInfo:reference:c0-e19,attachments:reference:c0-e20,anchorQuestions:reference:c0-e21,jsonContent:reference:c0-e27,liveInfoDto:reference:c0-e28,yktRelatedLiveInfo:reference:c0-e29,mocVideoSegmentId:reference:c0-e30,videoSegmentInfoDtos:reference:c0-e31,completePercent:reference:c0-e32,learnTime:reference:c0-e33,voteCount:reference:c0-e34,replyCount:reference:c0-e35,testScore:reference:c0-e36,contentFileName:reference:c0-e37,visible:reference:c0-e38}',
      `batchId=${now}`,
    ].join('\n');
    const r = await this._post('/dwr/call/plaincall/MocQuizBean.fetchQuestions.dwr', {
      body: lines,
      headers: { 'Content-Type': 'text/plain' },
    });
    const data = parseDwrReply(r.text);
    const list = Array.isArray(data) ? data : [];
    const strip = (html) => String(html || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    return list.map((q) => ({
      id: q.id,
      type: q.type,
      title: strip(q.plainTextTitle || q.title).slice(0, 200),
      options: (q.optionsDetail ? JSON.parse(q.optionsDetail) : (q.optionDtos || [])).map((o) => ({
        id: o.id,
        text: strip(o.content).slice(0, 100),
        isAnswer: o.answer === true,
      })),
    }));
  }

  // Headless real-player simulation: navigates to the video unit and plays muted
  // at the given speed (default 1x) in the transport browser. Everything is
  // site-native: heartbeats, watch time, finished report all come from the player
  // itself; a background watcher auto-answers in-video anchor questions with the
  // CORRECT option (leaked via fetchQuestions optionsDetail). Playback keeps
  // running across MCP calls; poll with watchStatus().
  async watchVideo({ termId, unitId, speed = 1 }) {
    await this.ensureTransport();
    const tid = String(termId);
    const tree = await this.getLastLearnedTerm(tid);
    const unit = this.flattenUnits(tree).find((u) => u.unitId === Number(unitId));
    if (!unit || unit.contentType !== 1) throw new Error('找不到该视频任务点: ' + unitId);
    let courseSlug = this._slugByCourse[String(tree.courseId)];
    if (!courseSlug) {
      await this.listCourses();
      courseSlug = this._slugByCourse[String(tree.courseId)];
    }
    if (!courseSlug) throw new Error('无法解析课程 URL 前缀:请先调 mk_list_courses');
    const url = `${this.origin}/learn/${courseSlug}?tid=${tid}#/learn/content?type=detail&id=${unit.lessonId}&cid=${unit.unitId}&contentid=${unit.contentId}`;
    await this._page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await this._page.waitForSelector('video', { timeout: 60000 });
    this._stableUrl = url;
    // restart from the beginning: the player auto-resumes to last position, which
    // for previously-skipped videos is the END. Seek to 0 before and shortly after play.
    await this._page.evaluate((rate) => {
      const v = document.querySelector('video');
      v.muted = true;
      try { v.currentTime = 0; } catch {}
      v.playbackRate = rate;
      const p = v.play();
      if (p && p.catch) p.catch(() => {});
      setTimeout(() => { try { if (v.currentTime > 15) v.currentTime = 0; } catch {} }, 1200);
      return { duration: v.duration || null, currentTime: v.currentTime || 0 };
    }, Number(speed) || 1);
    await new Promise((r) => setTimeout(r, 1800));
    // fetch anchor questions (correct options leaked in optionsDetail)
    const anchorMap = {};
    let anchorCount = 0;
    if (unit.anchorQuestions?.length) {
      try {
        const qs = await this.fetchAnchorQuestions({
          unitId: unit.unitId,
          gmtCreate: unit.gmtCreate,
          name: unit.name,
          lessonId: unit.lessonId,
          chapterId: unit.chapterId,
          termId: tid,
          videoId: unit.contentId,
          durationInSeconds: unit.durationInSeconds,
          completePercent: unit.completePercent ?? 1,
          learnTime: unit.learnTime ?? 0,
          anchors: unit.anchorQuestions,
        });
        anchorCount = qs.length;
        for (const q of qs) {
          const correct = q.options.find((o) => o.isAnswer);
          if (correct) anchorMap[q.id] = correct.id;
        }
      } catch {}
    }
    const start = { duration: this._watch?.duration ?? null, currentTime: 0 };
    this._watch = {
      startedAt: Date.now(), unitId, contentId: unit.contentId,
      duration: start.duration, currentTime: start.currentTime,
      answered: 0, state: 'playing', url, anchors: anchorCount,
    };
    const w = this._watch;
    const amap = anchorMap;
    (async () => {
      let pausedStreak = 0;
      while (this._watch === w && !w.done) {
        try {
          const st = await this._page.evaluate((amap) => {
            const vis = (el) => el && el.offsetParent !== null;
            const v = document.querySelector('video');
            if (!v) return { state: 'novideo' };
            const submitBtn = Array.from(document.querySelectorAll('a,button')).find(
              (b) => vis(b) && /^\s*提交\s*$/.test(b.innerText || ''),
            );
            if (submitBtn) {
              const radios = Array.from(document.querySelectorAll('input[type=radio]')).filter(vis);
              let picked = null;
              for (const r of radios) {
                const id = r.id || '';
                for (const [qid, optId] of Object.entries(amap)) {
                  if (id.includes('_' + qid + '_') && id.includes(String(optId))) picked = r;
                }
              }
              if (picked) picked.click();
              else if (radios.length) radios[0].click();
              submitBtn.click();
              return { state: 'anchor-answered', viaCorrect: !!picked };
            }
            if (v.ended) return { state: 'ended', currentTime: v.currentTime, duration: v.duration };
            if (v.paused) return { state: 'paused', currentTime: v.currentTime, duration: v.duration };
            return { state: 'playing', currentTime: v.currentTime, duration: v.duration };
          }, amap);
          w.currentTime = st.currentTime ?? w.currentTime;
          w.duration = st.duration ?? w.duration;
          if (st.state === 'anchor-answered') {
            w.answered++;
            w.lastAnchor = st.viaCorrect ? 'correct' : 'guess';
            w.state = 'playing';
            pausedStreak = 0;
          } else if (st.state === 'ended') {
            w.state = 'ended';
            w.done = true;
            break;
          } else if (st.state === 'paused') {
            pausedStreak++;
            w.state = 'paused';
            if (pausedStreak >= 3) {
              await this._page.evaluate(() => {
                const vis = (el) => el && el.offsetParent !== null;
                const cont = Array.from(document.querySelectorAll('a,button')).find(
                  (b) => vis(b) && /继续学习|继续|关闭/.test(b.innerText || ''),
                );
                if (cont) cont.click();
                const v = document.querySelector('video');
                if (v && v.paused) { const p = v.play(); if (p && p.catch) p.catch(() => {}); }
              });
              pausedStreak = 0;
            }
          } else {
            w.state = st.state;
            pausedStreak = 0;
          }
        } catch (e) {
          w.state = 'page-error: ' + String(e).slice(0, 80);
        }
        await sleep(1500);
      }
    })();
    return { started: true, duration: w.duration, currentTime: w.currentTime, speed: Number(speed) || 1, anchors: anchorCount };
  }

  watchStatus() {
    return this._watch ? { ...this._watch } : { state: 'idle' };
  }

  // Pad a video unit's watch duration (学习时长): N paced LEARN_TIME_COUNT
  // heartbeats of reportSeconds each. Verified: each accepted report adds
  // ~reportSeconds/60 to the unit's learnTime (server does not validate the
  // wall-clock timeline).
  async padWatchTime({ unitId, courseId, lessonId, videoId, termId, userId, reports, startIndex = 1, videoTime, reportSeconds = 60, gapMs = 13000 }) {
    await this.ensureTransport();
    const uid = userId || this._memberId || (await this.resolveMemberId().catch(() => null));
    if (!uid) throw new Error('缺少 userId(无法从会话解析 memberId)');
    const out = [];
    for (let i = 0; i < reports; i++) {
      const r = await this.rpcSigned({
        unitId, finished: false, index: startIndex + i, duration: 60000,
        courseId, lessonId, videoId, termId,
        userId: String(uid), contentType: 1, action: 'LEARN_TIME_COUNT',
        videoTime: videoTime ?? 60, learnedVideoTimeCount: reportSeconds,
      });
      out.push(r.json?.code ?? r.status);
      await new Promise((res) => setTimeout(res, gapMs));
    }
    return { reports, codes: out };
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
        const courseId = String(card.id ?? it.id ?? '');
        if (card.schoolSN && courseId) this._slugByCourse[courseId] = card.schoolSN + '-' + courseId;
        return {
          termId: card.currentTermId ?? null,
          courseId,
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
            learnTime: u.learnTime ?? null,
            gmtCreate: u.gmtCreate ?? null,
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
