/**
 * 打包产物冒烟测试：验证 dist\TaobaoInsight.exe 本身可用
 * （而不是源码 `electron .` 可用）。
 *
 * 做三件事：
 *   1. 启动 exe，确认窗口起来、渲染进程来自 app.asar
 *   2. 检查 preload 桥与自动初始化
 *   3. 跑一次真实搜索，确认打包后的抓取代码能跑通并落盘
 *
 * 运行：node test/smoke-exe.js [调试端口，默认 9334]
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");

const cdp = require("../src/cdp");

const PORT = Number(process.argv[2] || 9334);
const EXE = path.join(__dirname, "..", "dist", "TaobaoInsight.exe");
const OUTPUT_DIR = path.join(os.homedir(), "TaobaoInsight-data");

let child = null;
let client = null;
let pass = 0;
let fail = 0;
const failures = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "相等"}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

async function test(name, fn) {
  process.stdout.write(`\n[TEST] ${name}\n`);
  try {
    const info = await fn();
    pass++;
    console.log(`  ✔ PASS${info !== undefined ? "  " + JSON.stringify(info) : ""}`);
  } catch (e) {
    fail++;
    failures.push(`${name} → ${e.message}`);
    console.log(`  ✘ FAIL  ${e.message}`);
  }
}

const evalInPage = (expr, timeoutMs = 45000) => cdp.evaluate(client, expr, timeoutMs);

/** 等渲染进程的 DOM 与 preload 桥就绪（exe 冷启动时窗口先出现、页面后加载） */
async function waitReady(timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ok = await evalInPage(
        `!!(window.api && document.getElementById("log") && document.getElementById("browserDot"))`
      );
      if (ok) return Date.now() - t0;
    } catch {}
    await cdp.sleep(500);
  }
  throw new Error(`渲染进程未就绪（等了 ${timeoutMs}ms）`);
}

async function waitIdle(timeoutMs = 180000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const busy = await evalInPage(
      `(function(){ var b=document.getElementById("busy"); return !!(b && !b.classList.contains("hidden")); })()`
    );
    if (!busy) return Date.now() - t0;
    await cdp.sleep(800);
  }
  // 超时是最难排查的失败——把应用日志尾部一起带出来
  let tail = "";
  try {
    tail = await evalInPage(`document.getElementById("log").textContent.slice(-400)`);
  } catch {}
  throw new Error(`等待界面空闲超时（${timeoutMs}ms）｜应用日志尾部：${String(tail).replace(/\s+/g, " ")}`);
}

function stopApp() {
  try {
    client && client.close();
  } catch {}
  if (child && child.pid) {
    try {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
    } catch {}
  }
  // portable 版可能还有游离进程，一并清理
  try {
    execSync("taskkill /IM TaobaoInsight.exe /F", { stdio: "ignore" });
  } catch {}
}

async function main() {
  console.log("=".repeat(64));
  console.log("淘宝采集器 · 打包产物（exe）冒烟测试");
  console.log("=".repeat(64));

  const t0 = Date.now();

  await test("产物存在且体积合理", () => {
    assert(fs.existsSync(EXE), `未找到 ${EXE}，请先执行 npm run dist`);
    const mb = fs.statSync(EXE).size / 1024 / 1024;
    assert(mb > 40 && mb < 300, `体积异常：${mb.toFixed(1)} MB`);
    return { exe: path.basename(EXE), sizeMB: Number(mb.toFixed(1)) };
  });

  await test("双击启动：窗口进程与调试端口就绪", async () => {
    child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (d) => {
      const s = String(d).trim();
      if (s) console.log("  [app] " + s.slice(0, 160));
    });
    child.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s && !/DevTools listening|GPU|gpu_|Autofill/i.test(s)) console.log("  [err] " + s.slice(0, 160));
    });

    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (await cdp.isCdpAlive("127.0.0.1", PORT)) break;
      await cdp.sleep(700);
    }
    assert(await cdp.isCdpAlive("127.0.0.1", PORT), "调试端口未就绪（应用可能启动失败）");
    return { port: PORT };
  });

  await test("渲染进程来自打包后的 app.asar", async () => {
    const deadline = Date.now() + 30000;
    let page = null;
    while (Date.now() < deadline && !page) {
      const targets = await cdp.listTargets("127.0.0.1", PORT).catch(() => []);
      page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
      if (!page) await cdp.sleep(600);
    }
    assert(page, "未找到应用窗口");
    client = await cdp.attach(page.webSocketDebuggerUrl);
    assert(/app\.asar/.test(page.url), `窗口应加载 asar 内页面，实际：${page.url}`);
    const readyMs = await waitReady();
    const title = await evalInPage("document.title");
    assert(/淘宝/.test(title), `窗口标题：${title}`);
    return { url: page.url.replace(/^.*app\.asar/, "app.asar"), title, readyMs };
  });

  await test("preload 桥完整且自动初始化成功", async () => {
    // 自动初始化（拉起浏览器 + 读登录态）不经过忙锁，所以不能只等 waitIdle，
    // 必须轮询到浏览器状态真正落到"就绪"，否则会偶发读到初始文案"浏览器未启动"。
    const waitStart = Date.now();
    const deadline = waitStart + 90000;
    let s = null;
    while (Date.now() < deadline) {
      s = JSON.parse(
        await evalInPage(
          `JSON.stringify({
             apiCount: window.api ? Object.keys(window.api).length : 0,
             browserText: document.getElementById("browserText").textContent,
             browserDot: document.getElementById("browserDot").className,
             loginText: document.getElementById("loginText").textContent,
             log: document.getElementById("log").textContent
           })`
        )
      );
      if (/就绪/.test(s.browserText) && /ok/.test(s.browserDot)) break;
      await cdp.sleep(600);
    }
    const waited = Date.now() - waitStart;
    eq(s.apiCount, 16, "暴露的 API 数量");
    assert(/就绪/.test(s.browserText), `浏览器状态：${s.browserText}`);
    assert(/ok/.test(s.browserDot), `浏览器指示灯：${s.browserDot}`);
    assert(!/未知/.test(s.loginText), `登录态：${s.loginText}`);
    assert(/数据目录/.test(s.log), "启动日志应含数据目录");
    return { apiCount: s.apiCount, browser: s.browserText, login: s.loginText, waitedMs: waited };
  });

  await test("打包后的抓取链路可用：真实搜索 + 落盘", async () => {
    await evalInPage(
      `(function(){
         document.getElementById("kw").value = "保温杯";
         document.getElementById("doSort").checked = true;
         document.getElementById("maxItems").value = "60";
         document.getElementById("btnSearch").click();
         return "clicked";
       })()`
    );
    // 搜索内置了限流重试（最多 3 次），打包环境慢，给足预算
    await waitIdle(300000);

    const ui = JSON.parse(
      await evalInPage(
        `JSON.stringify({
           rows: document.querySelectorAll("#gridBody tr").length,
           foot: document.getElementById("foot").textContent
         })`
      )
    );
    assert(ui.rows >= 20, `表格行数：${ui.rows}`);
    const fm = ui.foot.match(/已导出\s+(.+\.csv)/);
    assert(fm, `底栏未见导出路径：${ui.foot}`);
    const csv = fm[1].trim();
    const json = csv.replace(/\.csv$/, ".json");
    assert(fs.existsSync(csv), `CSV 未落盘：${csv}`);
    assert(fs.existsSync(json), `JSON 未落盘：${json}`);

    const data = JSON.parse(fs.readFileSync(json, "utf8"));
    assert(data.count >= 20, `落盘条数：${data.count}`);
    eq(data.sales_sorted, true, "排序标记");
    assert(data.data[0].sales_text, "含销量原文");
    return { rows: ui.rows, count: data.count, csv: path.basename(csv), outDir: OUTPUT_DIR.replace(os.homedir(), "~") };
  });

  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败   （耗时 ${cost}s）`);
  if (failures.length) {
    console.log("\n失败明细：");
    failures.forEach((f) => console.log("  ✘ " + f));
  }
  console.log("=".repeat(64));

  stopApp();
  await cdp.sleep(1500);
  process.exit(fail ? 1 : 0);
}

process.on("SIGINT", () => {
  stopApp();
  process.exit(130);
});

main().catch((e) => {
  console.error("\n冒烟测试异常：", e.stack || e.message);
  stopApp();
  process.exit(2);
});
