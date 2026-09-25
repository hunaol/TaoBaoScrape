// 浏览器发现 / 拉起 / 标签页管理
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const cdp = require("./cdp");

const PORT = 9222;

/** 按优先级找可用的 Chromium 内核浏览器 */
function findBrowser() {
  const pf = process.env["ProgramFiles"] || "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] || "";
  const candidates = [
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

/** 默认用户数据目录（放在用户目录下，保证可写，不碰日常浏览器配置） */
function defaultProfileDir() {
  return path.join(os.homedir(), ".taobao-insight", "browser-profile");
}

/** 拉起浏览器并打开调试端口。已在该端口运行则直接复用。 */
async function ensureBrowser({ port = PORT, profileDir = defaultProfileDir(), startUrl, log = () => {} } = {}) {
  if (await cdp.isCdpAlive("127.0.0.1", port)) {
    log(`复用已在 ${port} 端口运行的浏览器`);
    if (startUrl) await openTab(startUrl, { port });
    return { launched: false, port, profileDir };
  }

  const exe = findBrowser();
  if (!exe) {
    throw new Error("未找到 Chrome 或 Edge，请先安装其中之一");
  }
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-features=Translate,OptimizationHints",
    "--disable-backgrounding-occluded-windows",
  ];
  if (startUrl) args.push(startUrl);

  log(`启动浏览器: ${exe}`);
  const child = spawn(exe, args, { detached: true, stdio: "ignore" });
  child.unref();

  // 等 CDP 就绪
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (await cdp.isCdpAlive("127.0.0.1", port)) {
      log("浏览器调试端口就绪");
      return { launched: true, port, profileDir, exe };
    }
    await cdp.sleep(500);
  }
  throw new Error("浏览器启动超时，调试端口未就绪");
}

/** 所有可脚本化的页面标签 */
async function pageTargets({ port = PORT } = {}) {
  const all = await cdp.listTargets("127.0.0.1", port);
  return all.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
}

/** 新建标签页并返回其 target */
async function openTab(url, { port = PORT } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
    method: "PUT",
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`新建标签页失败: HTTP ${res.status}`);
  return res.json();
}

/** 关闭标签页 */
async function closeTab(targetId, { port = PORT } = {}) {
  try {
    await fetch(`http://127.0.0.1:${port}/json/close/${targetId}`, { signal: AbortSignal.timeout(5000) });
  } catch {}
}

module.exports = {
  PORT,
  findBrowser,
  defaultProfileDir,
  ensureBrowser,
  pageTargets,
  openTab,
  closeTab,
};
