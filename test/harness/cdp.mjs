// A small Chrome DevTools Protocol driver: headless Chrome on a temporary
// profile, one plain WebSocket to it, one flattened session per page. No
// dependencies (Node's own WebSocket).
//
//   const browser = await launch();
//   const page = await browser.newPage(PHONE);
//   await page.go('http://127.0.0.1:8791/?as=owner');
//   await page.until('window.app?.ready', 30000);
//   await page.shot('/tmp/phone.png');
//   console.log(page.errors, page.requests);
//   await browser.close();
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const DESKTOP = Object.freeze({ width: 1440, height: 900 });
export const PHONE = Object.freeze({ width: 390, height: 844, dpr: 3, mobile: true, touch: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (s) => (s.length > 80 ? `${s.slice(0, 77)}...` : s);

function exceptionText(d) {
  const e = d.exception;
  const text = e?.description ?? e?.value ?? d.text;
  return d.url ? `${text} (${d.url}:${d.lineNumber + 1})` : String(text);
}
function argText(a) {
  if (a.type === 'string') return a.value;
  if ('value' in a) return JSON.stringify(a.value);
  return a.description ?? a.type;
}

export async function launch({ chrome = CHROME, headless = true, args = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'harness-chrome-'));
  const proc = spawn(chrome, [
    ...(headless ? ['--headless=new'] : []), '--remote-debugging-port=0', `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update',
    '--disable-sync', '--hide-scrollbars', '--mute-audio', '--enable-unsafe-swiftshader', ...args, 'about:blank',
  ], { stdio: 'ignore' });

  // Chrome writes its port and browser endpoint to DevToolsActivePort.
  const portFile = join(dir, 'DevToolsActivePort');
  const t0 = Date.now();
  let endpoint;
  while (!endpoint) {
    if (proc.exitCode !== null) throw new Error(`Chrome exited with ${proc.exitCode}`);
    if (Date.now() - t0 > 20000) { proc.kill(); throw new Error('Chrome did not start'); }
    const lines = existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n') : [];
    if (lines[1]) endpoint = `ws://127.0.0.1:${lines[0]}${lines[1]}`;
    else await sleep(50);
  }
  const ws = new WebSocket(endpoint);
  await new Promise((ok, fail) => { ws.onopen = ok; ws.onerror = () => fail(new Error(`Could not connect to ${endpoint}`)); });

  let nextId = 1;
  const waiting = new Map(); // id -> { ok, fail, method }
  const sessions = new Map(); // sessionId -> event handler
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w?.fail(new Error(`${w.method}: ${msg.error.message}`)); else w?.ok(msg.result);
    } else if (msg.sessionId) sessions.get(msg.sessionId)?.(msg.method, msg.params);
  };
  ws.onclose = () => { for (const w of waiting.values()) w.fail(new Error(`${w.method}: Chrome went away`)); waiting.clear(); };
  const send = (method, params = {}, sessionId) => new Promise((ok, fail) => {
    const id = nextId++;
    waiting.set(id, { ok, fail, method });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
  });

  async function newPage({ width = DESKTOP.width, height = DESKTOP.height, mobile = false, touch = false, dpr = 1, userAgent } = {}) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    const s = (method, params) => send(method, params, sessionId);
    const listeners = new Set();
    const page = {
      targetId, sessionId, send: s,
      errors: [], // uncaught exceptions, console.error, and the browser's own error log (failed loads)
      console: [], // every console message: { type, text }
      requests: [], // every URL requested
      responses: [], // { url, status }
      failed: [], // { url, error } for requests that never got an answer
    };
    sessions.set(sessionId, (method, params) => {
      if (method === 'Runtime.exceptionThrown') page.errors.push(exceptionText(params.exceptionDetails));
      else if (method === 'Runtime.consoleAPICalled') {
        const text = params.args.map(argText).join(' ');
        page.console.push({ type: params.type, text });
        if (params.type === 'error' || params.type === 'assert') page.errors.push(text);
      } else if (method === 'Log.entryAdded') {
        if (params.entry.level === 'error') page.errors.push(params.entry.url ? `${params.entry.text} (${params.entry.url})` : params.entry.text);
      } else if (method === 'Network.requestWillBeSent') page.requests.push(params.request.url);
      else if (method === 'Network.responseReceived') page.responses.push({ url: params.response.url, status: params.response.status });
      else if (method === 'Network.loadingFailed') page.failed.push({ id: params.requestId, error: params.errorText, canceled: !!params.canceled });
      for (const l of listeners) l(method, params);
    });
    // The next event of this kind (optionally matching), within ms.
    page.once = (method, ms = 30000, match = () => true) => new Promise((ok, fail) => {
      const timer = setTimeout(() => { listeners.delete(l); fail(new Error(`No ${method} within ${ms} ms`)); }, ms);
      const l = (m, p) => { if (m === method && match(p)) { clearTimeout(timer); listeners.delete(l); ok(p); } };
      listeners.add(l);
    });

    await Promise.all(['Page.enable', 'Runtime.enable', 'Network.enable', 'Log.enable'].map((m) => s(m)));
    await s('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: dpr, mobile });
    if (touch) await s('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    if (userAgent) await s('Emulation.setUserAgentOverride', { userAgent });

    page.go = async (url, ms = 30000) => {
      const loaded = page.once('Page.loadEventFired', ms);
      const r = await s('Page.navigate', { url });
      if (r.errorText) { loaded.catch(() => {}); throw new Error(`${url}: ${r.errorText}`); }
      await loaded;
    };
    page.reload = async (ms = 30000) => {
      const loaded = page.once('Page.loadEventFired', ms);
      await s('Page.reload', {});
      await loaded;
    };
    // An expression, or a function and its (JSON) arguments; promises are awaited.
    page.ev = async (expr, ...args) => {
      const expression = typeof expr === 'function' ? `(${expr})(${args.map((a) => JSON.stringify(a)).join(', ')})` : expr;
      const r = await s('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
      if (r.exceptionDetails) throw new Error(`ev(${short(String(expr))}): ${exceptionText(r.exceptionDetails)}`);
      return r.result.value;
    };
    // Polls until the expression is truthy and returns its value.
    page.until = async (expr, ms = 10000, every = 50) => {
      const end = Date.now() + ms;
      let last;
      for (;;) {
        try { const v = await page.ev(expr); if (v) return v; last = v; } catch (e) { last = e.message; }
        if (Date.now() > end) throw new Error(`until(${short(String(expr))}) timed out after ${ms} ms (last: ${JSON.stringify(last)})`);
        await sleep(every);
      }
    };
    page.mouse = async (x, y) => {
      await s('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await s('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await s('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    };
    // Touch events on a touch page, a mouse click otherwise.
    page.tap = async (x, y) => {
      if (!touch) return page.mouse(x, y);
      await s('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await s('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    page.click = async (selector) => {
      const at = await page.ev((sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }, selector);
      if (!at) throw new Error(`click: nothing matches ${selector}`);
      await page.tap(at.x, at.y);
    };
    page.shot = async (path) => {
      const { data } = await s('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path, Buffer.from(data, 'base64'));
      return path;
    };
    page.close = async () => {
      sessions.delete(sessionId);
      await send('Target.closeTarget', { targetId }).catch(() => {});
    };
    return page;
  }

  return {
    newPage,
    send,
    async close() {
      await Promise.race([send('Browser.close').catch(() => {}), sleep(2000)]);
      ws.close();
      if (proc.exitCode === null) {
        const exited = new Promise((r) => proc.once('exit', r));
        proc.kill();
        await Promise.race([exited, sleep(3000)]);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
