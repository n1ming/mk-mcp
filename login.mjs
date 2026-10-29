// Interactive login via Playwright (stateful):
//   loginStart()  -> launches a real browser and returns immediately
//   loginState()  -> idle | running | success | failed | timeout | cancelled
//   loginCancel() -> closes the browser and marks the flow cancelled
// A background poller watches for cookies outside the anonymous baseline
// (name-agnostic; known trackers are excluded). With termId given, a candidate
// must additionally pass an in-page authed probe (code:0) before success —
// then ALL cookies (incl. HttpOnly) are snapshotted into the auth file.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let session = { state: 'idle' };

function publicView() {
  if (!session) return { state: 'idle' };
  const { state, startedAt, error, userId, csrfKey, cookieNames, authFile, baselineCount, freshCookieNames } = session;
  return {
    state,
    elapsedMs: startedAt ? Date.now() - startedAt : 0,
    ...(userId ? { userId } : {}),
    ...(csrfKey ? { csrfKey } : {}),
    ...(cookieNames ? { cookieNames } : {}),
    ...(authFile ? { authFile } : {}),
    ...(baselineCount ? { baselineCount } : {}),
    ...(freshCookieNames ? { freshCookieNames } : {}),
    ...(error ? { error } : {}),
  };
}

export function loginState() {
  return publicView();
}

export async function loginCancel() {
  if (!session || session.state !== 'running') {
    return { ...publicView(), cancelled: false, note: '没有进行中的登录流程' };
  }
  session.cancelled = true;
  try {
    await session.browser?.close();
  } catch {}
  session.state = 'cancelled';
  return { ...publicView(), cancelled: true };
}

export async function loginStart({ authFile, origin = 'https://www.icourse163.org', timeoutMs = 300000, termId }) {
  if (session.state === 'running') {
    return { started: false, ...publicView(), note: '已有登录流程进行中,用 mk_login_status 查看' };
  }
  session = { state: 'running', startedAt: Date.now(), authFile, termId: termId ? String(termId) : null };
  runLogin({ authFile, origin, timeoutMs, termId }).catch(() => {});
  return {
    started: true,
    ...publicView(),
    note: termId
      ? '请在弹出的浏览器窗口完成登录;mk_login_status 轮询(以鉴权接口实测 code:0 作为成功判据)'
      : '请在弹出的浏览器窗口完成登录;mk_login_status 轮询直到 success',
  };
}

async function runLogin({ authFile, origin, timeoutMs, termId }) {
  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: false });
  } catch {
    try {
      browser = await chromium.launch({ channel: 'msedge', headless: false });
    } catch {
      session.state = 'failed';
      session.error = '未找到本机 Chrome/Edge:请安装其一后重试(playwright-core 不自带浏览器)';
      return;
    }
  }
  session.browser = browser;
  try {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    console.error('[mk-mcp] 浏览器已打开,等待用户在窗口中完成登录(最长 %d 秒)...', Math.floor(timeoutMs / 1000));

    // Anonymous baseline: cookie names present before the user does anything
    // (wait 15s so late tracker cookies land in the baseline, not in "fresh").
    await sleep(15000);
    const TRACKER = /^(Hm_|HMACCOUNT|__snaker__id|gdxidpyhxdE|WM_|__yadk_uid)/;
    const baselineNames = new Set((await ctx.cookies()).map((c) => c.name));
    session.baselineCount = baselineNames.size;

    const deadline = Date.now() + timeoutMs;
    let loggedIn = false;
    let seenSig = null;
    let seenAt = 0;
    while (Date.now() < deadline) {
      if (session.cancelled) return;
      let fresh = [];
      try {
        const all = await ctx.cookies();
        fresh = [
          ...new Set(
            all
              .filter((c) => !baselineNames.has(c.name) && !TRACKER.test(c.name))
              .map((c) => c.name),
          ),
        ].sort();
      } catch (e) {
        session.state = 'failed';
        session.error = '浏览器会话异常(窗口被手动关闭?): ' + String(e).slice(0, 80);
        return;
      }
      if (fresh.length) {
        session.freshCookieNames = fresh;
        const sig = fresh.join(',');
        if (sig === seenSig && Date.now() - seenAt >= 4000) {
          if (!termId) {
            loggedIn = true;
            break;
          }
          // positive confirmation: in-page authed probe must return code:0
          const probe = await page
            .evaluate(async (tid) => {
              const m = document.cookie.match(/NTESSTUDYSI=([^;]+)/);
              const r = await fetch('/web/j/courseBean.getLastLearnedMocTermDto.rpc?csrfKey=' + (m ? m[1] : ''), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'termId=' + tid,
              });
              return await r.text();
            }, String(termId))
            .catch(() => null);
          let ok = false;
          try {
            ok = JSON.parse(probe).code === 0;
          } catch {}
          if (ok) {
            loggedIn = true;
            break;
          }
          seenSig = null; // rejected: wait for the real login cookies
        } else if (sig !== seenSig) {
          seenSig = sig;
          seenAt = Date.now();
        }
      }
      await sleep(2500);
    }
    if (session.cancelled) return;
    if (!loggedIn) {
      session.state = 'timeout';
      session.error = `等待登录超时:基线 ${baselineNames.size} 个 cookie 外未出现稳定且验证通过的新 cookie${
        session.freshCookieNames ? '(已观测到: ' + session.freshCookieNames.join(',') + ')' : ''
      }。请重新调用 mk_login_start。`;
      return;
    }

    await sleep(1500); // let cookies settle after login redirect
    const cookies = await ctx.cookies([
      'https://www.icourse163.org',
      'https://icourse163.org',
      'https://www.163.com',
      'https://study.163.com',
    ]);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    const auth = {
      savedAt: Date.now(),
      origin,
      userAgent,
      csrfKey: cookies.find((c) => c.name === 'NTESSTUDYSI')?.value || null,
      userId: cookies.find((c) => c.name === 'NTES_STUID')?.value || null,
      cookies,
    };
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, JSON.stringify(auth, null, 2));
    session.state = 'success';
    session.userId = auth.userId;
    session.csrfKey = auth.csrfKey;
    session.cookieNames = cookies.map((c) => c.name);
  } catch (e) {
    if (!session.cancelled) {
      session.state = 'failed';
      session.error = String(e?.message || e).slice(0, 200);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}
