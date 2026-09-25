// 最小 CDP(Chrome DevTools Protocol) 客户端 + 标签页管理
const WebSocket = require("ws");

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 9222;

class CdpError extends Error {}

/** 列出当前浏览器所有调试目标 */
async function listTargets(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  const res = await fetch(`http://${host}:${port}/json`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new CdpError(`CDP 返回 ${res.status}`);
  return res.json();
}

/** 探测端口上是否有可用的调试浏览器 */
async function isCdpAlive(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  try {
    const v = await fetch(`http://${host}:${port}/json/version`, { signal: AbortSignal.timeout(3000) });
    return v.ok;
  } catch {
    return false;
  }
}

/** 建立一个到某个标签页的 CDP 连接 */
async function attach(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { handshakeTimeout: 10000, maxPayload: 256 * 1024 * 1024 });
    let seq = 0;
    const pending = new Map();
    let closed = false;

    const fail = (err) => {
      closed = true;
      for (const [, p] of pending) p.reject(err);
      pending.clear();
    };

    const listeners = new Map();

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new CdpError(`${p.method}: ${msg.error.message || JSON.stringify(msg.error)}`));
        else p.resolve(msg.result);
        return;
      }
      // 无 id 的是 CDP 事件通知
      if (msg.method && listeners.has(msg.method)) {
        for (const fn of listeners.get(msg.method)) {
          try {
            fn(msg);
          } catch {}
        }
      }
    });
    ws.on("error", (e) => fail(e));
    ws.on("close", () => fail(new CdpError("CDP 连接已关闭")));
    ws.on("open", () => {
      resolve({
        send(method, params = {}, timeoutMs = 45000) {
          if (closed) return Promise.reject(new CdpError("CDP 连接已关闭"));
          return new Promise((res, rej) => {
            const id = ++seq;
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new CdpError(`${method} 超时(${timeoutMs}ms)`));
            }, timeoutMs);
            pending.set(id, { resolve: res, reject: rej, timer, method });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(fn);
          return () => listeners.get(method).delete(fn);
        },
        close() {
          closed = true;
          try {
            ws.close();
          } catch {}
        },
      });
    });
  });
}

/** 在标签页里执行 JS 并取回结果（自动 await Promise） */
async function evaluate(client, expression, timeoutMs = 45000) {
  const r = await client.send(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    timeoutMs
  );
  if (r.exceptionDetails) {
    const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "页面 JS 抛错";
    throw new CdpError(d);
  }
  return r.result ? r.result.value : undefined;
}

/** 等待页面加载完成（DOM 就绪 + 可选等待条件） */
async function waitForLoad(client, { timeoutMs = 30000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  // 先确保 Page 域开启，否则事件不来
  try {
    await client.send("Page.enable");
  } catch {}
  while (Date.now() < deadline) {
    try {
      const state = await evaluate(client, "document.readyState");
      if (state === "complete" || state === "interactive") return true;
    } catch {}
    await sleep(400);
  }
  return false;
}

/** 轮询直到 evaluate(expr) 返回真值 */
async function waitFor(client, expr, { timeoutMs = 30000, intervalMs = 500 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const v = await evaluate(client, expr, 15000);
      if (v) return v;
    } catch {}
    await sleep(intervalMs);
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  CdpError,
  DEFAULT_HOST,
  DEFAULT_PORT,
  listTargets,
  isCdpAlive,
  attach,
  evaluate,
  waitForLoad,
  waitFor,
  sleep,
};
