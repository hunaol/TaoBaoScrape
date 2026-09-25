// 登录流程：拉起浏览器 -> 打开淘宝登录页 -> 轮询登录状态
const browser = require("./browser");
const cdp = require("./cdp");

const LOGIN_URL = "https://login.taobao.com/member/login.jhtml";
const HOME_URL = "https://www.taobao.com";

const isTaobaoDomain = (u) => /(^|\.)taobao\.com|(^|\.)tmall\.com/.test(String(u || ""));

/** 找一个淘宝域的标签页，没有就开一个 */
async function ensureTaobaoTab({ port = browser.PORT, log = () => {} } = {}) {
  const targets = await browser.pageTargets({ port });
  let t = targets.find((x) => isTaobaoDomain(x.url) && !/login\.taobao\.com/.test(x.url));
  if (!t) t = targets.find((x) => isTaobaoDomain(x.url));
  if (!t) {
    log("打开淘宝首页");
    t = await browser.openTab(HOME_URL, { port });
    await cdp.sleep(2500);
  }
  const client = await cdp.attach(t.webSocketDebuggerUrl);
  await client.send("Page.bringToFront").catch(() => {});
  return { target: t, client };
}

/**
 * 读登录态。
 * 关键：不能用 `document.cookie` —— 它按当前页面域隔离，而 `unb` 是 `.taobao.com` 的 cookie，
 * 一旦脚本落在 detail.tmall.com 这类标签上就读不到，会把已登录误判成未登录。
 * 所以走 CDP 的 Network.getCookies，按目标 URL 取全量 cookie。
 *
 * - `unb`  用户数字 ID（登录后才有）
 * - `_nk_` 昵称（URL 编码）
 */
async function getLoginState({ port = browser.PORT, log = () => {} } = {}) {
  const { target, client } = await ensureTaobaoTab({ port, log });
  try {
    const href = await cdp.evaluate(client, "location.href").catch(() => "");
    const url = String(href || target.url || "");

    let cookies = [];
    try {
      const r = await client.send(
        "Network.getCookies",
        { urls: ["https://www.taobao.com", "https://i.taobao.com", "https://login.taobao.com"] },
        10000
      );
      cookies = r.cookies || [];
    } catch {
      // 兜底：退回读当前页面 cookie（仅在 taobao.com 域标签上才准确）
      const raw = await cdp.evaluate(client, "document.cookie").catch(() => "");
      cookies = String(raw || "")
        .split("; ")
        .map((kv) => {
          const i = kv.indexOf("=");
          return i < 0 ? null : { name: kv.slice(0, i), value: kv.slice(i + 1) };
        })
        .filter(Boolean);
    }

    const get = (n) => {
      const c = cookies.find((x) => x.name === n);
      return c ? c.value : "";
    };
    let nick = "";
    try {
      nick = decodeURIComponent(get("_nk_") || "");
    } catch {
      nick = get("_nk_") || "";
    }
    const unb = get("unb") || "";

    return {
      logged_in: unb.length > 3 && !/login\.taobao\.com/.test(url),
      user_id: unb,
      nick: nick || get("tracknick") || "",
      url: url.slice(0, 120),
    };
  } finally {
    client.close();
  }
}

/** 打开登录页并把窗口提到前台，让用户自己完成登录（不代填账号密码） */
async function openLoginPage({ port = browser.PORT, log = () => {} } = {}) {
  const targets = await browser.pageTargets({ port });
  let t = targets.find((x) => /login\.taobao\.com/.test(x.url));
  let fresh = false;
  if (!t) {
    t = await browser.openTab(LOGIN_URL, { port });
    fresh = true;
  }
  const client = await cdp.attach(t.webSocketDebuggerUrl);
  try {
    if (!fresh) {
      await client.send("Page.navigate", { url: LOGIN_URL });
      await cdp.waitForLoad(client, { timeoutMs: 25000 }).catch(() => {});
    }
    await client.send("Page.bringToFront").catch(() => {});
    await cdp.sleep(1500);
    return { ok: true, url: LOGIN_URL };
  } finally {
    client.close();
  }
}

/** 轮询等待登录完成（用户扫码/输密码期间，我们只观察 cookie 变化） */
async function waitForLogin({ port = browser.PORT, timeoutMs = 300000, intervalMs = 3000, onTick = () => {}, log = () => {} } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const st = await getLoginState({ port, log }).catch(() => ({ logged_in: false }));
    onTick(st);
    if (st.logged_in) {
      log(`登录成功：${st.nick || st.user_id}`);
      return st;
    }
    await cdp.sleep(intervalMs);
  }
  return { logged_in: false, timeout: true };
}

module.exports = { LOGIN_URL, HOME_URL, ensureTaobaoTab, getLoginState, openLoginPage, waitForLogin };
