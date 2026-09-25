/**
 * GUI / IPC 层端到端测试：真的启动 Electron 应用，
 * 通过 Chromium 远程调试协议连进渲染进程，在页面上下文里调用 window.api.*，
 * 验证 preload 桥 → ipcMain → src 的完整链路，以及界面是否随之更新。
 *
 * 运行：node test/e2e-gui.js
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn, execSync } = require("child_process");

const cdp = require("../src/cdp");

const PORT = 9333; // Electron 自身调试端口，与业务用的 9222 分开
const APP_DIR = path.join(__dirname, "..");
const OUTPUT_DIR = path.join(os.homedir(), "TaobaoInsight-data");
const ITEM = "https://detail.tmall.com/item.htm?id=980221506328";

let child = null;
let client = null;
let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skips = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "相等"}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

// 淘宝风控（验证码 / 空列表 / 空壳详情页）是**环境**问题，不是产品缺陷。
// 命中这类原因时把用例标记为 SKIP 并原样打印原因，既不伪装成通过，也不误报为失败。
const PUNISH_RE = /淘宝弹出人机验证|空搜索结果|详情页未正常渲染|列表未返回/;
/** 把风控类错误转成 SKIP */
function asSkip(e, ctx) {
  if (PUNISH_RE.test(e && e.message)) return makeSkip(ctx, e.message);
  return e;
}
/** 显式跳过（用于上游已因风控跳过、下游缺数据的情况） */
function makeSkip(ctx, why) {
  const err = new Error(`SKIP: ${ctx} —— ${why}`);
  err.skip = true;
  return err;
}

async function test(name, fn) {
  process.stdout.write(`\n[TEST] ${name}\n`);
  try {
    const info = await fn();
    pass++;
    console.log(`  ✔ PASS${info !== undefined ? "  " + JSON.stringify(info) : ""}`);
  } catch (e) {
    if (e && (e.skip || /^SKIP:/.test(e.message))) {
      skip++;
      skips.push(`${name} → ${e.message}`);
      console.log(`  ⚠ SKIP  ${e.message}`);
      return;
    }
    fail++;
    failures.push(`${name} → ${e.message}`);
    console.log(`  ✘ FAIL  ${e.message}`);
  }
}

// ————————————————————— 页面内求值辅助 —————————————————————

/** 在渲染进程里求值（自动 await Promise） */
function evalInPage(expr, timeoutMs = 45000) {
  return cdp.evaluate(client, expr, timeoutMs);
}

/** 调用 preload 暴露的 window.api 方法 */
function callApi(method, payload, timeoutMs = 180000) {
  const arg = payload === undefined ? "" : JSON.stringify(payload);
  return evalInPage(`window.api.${method}(${arg})`, timeoutMs);
}

/** 等界面忙锁释放 */
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

// ————————————————————— 启动 / 关闭应用 —————————————————————

async function startApp() {
  const electronBin = require("electron"); // 在纯 Node 下该模块导出可执行文件路径
  console.log(`  [app] 启动 ${electronBin}`);
  child = spawn(electronBin, [APP_DIR, `--remote-debugging-port=${PORT}`], {
    cwd: APP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => {
    const s = String(d).trim();
    if (s) console.log("  [stdout] " + s.slice(0, 200));
  });
  child.stderr.on("data", (d) => {
    const s = String(d).trim();
    if (s && !/DevTools listening|Autofill|GPU|gpu_/i.test(s)) console.log("  [stderr] " + s.slice(0, 200));
  });

  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    if (await cdp.isCdpAlive("127.0.0.1", PORT)) break;
    await cdp.sleep(600);
  }
  if (!(await cdp.isCdpAlive("127.0.0.1", PORT))) throw new Error("Electron 调试端口未就绪");

  // 等渲染进程页面出现
  const dl2 = Date.now() + 30000;
  while (Date.now() < dl2) {
    const targets = await cdp.listTargets("127.0.0.1", PORT).catch(() => []);
    const page = targets.find((t) => t.type === "page" && /index\.html/.test(t.url));
    if (page) {
      client = await cdp.attach(page.webSocketDebuggerUrl);
      return;
    }
    await cdp.sleep(600);
  }
  throw new Error("未找到应用窗口的渲染进程");
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
}

// ————————————————————— 测试套件 —————————————————————

async function suiteShell() {
  await test("窗口已加载且标题正确", async () => {
    const info = await evalInPage(
      `JSON.stringify({ title: document.title, hasApi: !!window.api, w: window.innerWidth, h: window.innerHeight })`
    );
    const s = JSON.parse(info);
    assert(/淘宝/.test(s.title), `标题：${s.title}`);
    assert(s.w > 800 && s.h > 500, `窗口尺寸异常：${s.w}x${s.h}`);
    return s;
  });

  await test("preload 桥暴露了全部 API 方法", async () => {
    const expected = [
      "startBrowser", "openLogin", "loginState", "waitLogin",
      "runSearch", "fetchDetail", "probeReviews", "fetchReviews", "runBatch",
      "outputDir", "openOutput", "profileDir", "openUrl", "reveal",
      "onLog", "onProgress",
    ];
    const raw = await evalInPage(
      `JSON.stringify(${JSON.stringify(expected)}.map(function(k){
         return [k, typeof (window.api && window.api[k])];
       }))`
    );
    const rows = JSON.parse(raw);
    const bad = rows.filter(([, t]) => t !== "function");
    assert(bad.length === 0, `缺失或类型错误：${JSON.stringify(bad)}`);
    return { methods: rows.length };
  });

  await test("contextIsolation 生效：渲染进程拿不到 Node", async () => {
    const raw = await evalInPage(
      `JSON.stringify({ require: typeof window.require, process: typeof window.process, module: typeof window.module })`
    );
    const s = JSON.parse(raw);
    eq(s.require, "undefined", "window.require 不应存在");
    eq(s.process, "undefined", "window.process 不应存在");
    eq(s.module, "undefined", "window.module 不应存在");
    return s;
  });
}

async function suiteInitAndEnv() {
  await test("应用启动后自动完成初始化（浏览器拉起 + 登录态）", async () => {
    // renderer 里的自动初始化会占用 busy 锁，等它释放
    const waited = await waitIdle(90000);
    const raw = await evalInPage(
      `JSON.stringify({
         browserText: document.getElementById("browserText").textContent,
         browserDot: document.getElementById("browserDot").className,
         loginText: document.getElementById("loginText").textContent,
         loginDot: document.getElementById("loginDot").className,
         logLen: document.getElementById("log").textContent.length
       })`
    );
    const s = JSON.parse(raw);
    assert(/就绪/.test(s.browserText), `浏览器状态未就绪：${s.browserText}`);
    assert(/ok/.test(s.browserDot), `浏览器指示灯应为绿：${s.browserDot}`);
    assert(!/未知/.test(s.loginText), `登录态未知：${s.loginText}`);
    assert(s.logLen > 40, "日志区应有内容");
    return { ...s, waitedMs: waited };
  });

  await test("env:outputDir / env:profileDir 返回真实路径", async () => {
    const out = await callApi("outputDir");
    const prof = await callApi("profileDir");
    eq(out, OUTPUT_DIR, "数据目录");
    assert(prof.includes(".taobao-insight"), `浏览器配置目录：${prof}`);
    assert(fs.existsSync(out), "数据目录应由应用创建好（用户要能直接打开）");
    return { out: out.replace(os.homedir(), "~"), prof: prof.replace(os.homedir(), "~") };
  });

  await test("browser:start 幂等：重复调用复用同一实例", async () => {
    const r = await callApi("startBrowser");
    eq(r.ok, true, "返回 ok");
    eq(r.port, 9222, "业务浏览器端口");
    return r;
  });

  await test("login:state 返回可用的登录态结构", async () => {
    const st = await callApi("loginState");
    assert(typeof st.logged_in === "boolean", "logged_in 是布尔值");
    return { logged_in: st.logged_in, nick: st.nick || "(未登录)", user_id: st.user_id || "-" };
  });
}

let searchCsv = null;
let searchJson = null;

async function suiteSearch() {
  await test("点击「搜索并导出」→ 结果渲染成表格且落盘", async () => {
    // 走真实用户路径：填表单 → 点按钮（而不是直接调 IPC）
    await evalInPage(
      `(function(){
         document.getElementById("kw").value = "保温杯";
         document.getElementById("doSort").checked = true;
         document.getElementById("maxItems").value = "60";
         document.getElementById("btnSearch").click();
         return "clicked";
       })()`
    );
    await cdp.sleep(700);
    const busyShown = await evalInPage(
      `(function(){ var b=document.getElementById("busy"); return !!(b && !b.classList.contains("hidden")); })()`
    );
    assert(busyShown, "点击搜索后应进入忙状态");
    assert(await evalInPage(`document.getElementById("btnSearch").disabled`), "忙时按钮应被禁用");

    await waitIdle(180000);

    const ui = JSON.parse(
      await evalInPage(
        `JSON.stringify({
           rows: document.querySelectorAll("#gridBody tr").length,
           firstCells: Array.prototype.map.call(
             document.querySelectorAll("#gridBody tr:first-child td"),
             function(td){ return td.textContent.trim(); }
           ),
           meta: document.getElementById("tableMeta").textContent,
           foot: document.getElementById("foot").textContent,
           buttonsDisabled: document.getElementById("btnSearch").disabled
         })`
      )
    );
    assert(ui.rows >= 20, `表格应渲染出结果，实际 ${ui.rows} 行`);
    eq(ui.buttonsDisabled, false, "任务结束后按钮应恢复可用");

    const m = ui.meta.match(/共 (\d+) 条/);
    assert(m, `表头统计格式异常：${ui.meta}`);
    eq(ui.rows, Number(m[1]), "表格行数应与统计一致");
    eq(ui.firstCells[0], "1", "首行序号");
    assert(/¥/.test(ui.firstCells[2]), `首行价格列：${ui.firstCells[2]}`);
    assert(ui.firstCells[1] && ui.firstCells[1] !== "-", `首行销量列：${ui.firstCells[1]}`);

    const fm = ui.foot.match(/已导出\s+(.+\.csv)/);
    assert(fm, `底栏应给出导出路径：${ui.foot}`);
    searchCsv = fm[1].trim();
    searchJson = searchCsv.replace(/\.csv$/, ".json");
    assert(fs.existsSync(searchCsv), `CSV 应落盘：${searchCsv}`);
    assert(fs.existsSync(searchJson), `JSON 应落盘：${searchJson}`);

    return { rows: ui.rows, meta: ui.meta, top: ui.firstCells.slice(0, 4).join(" | ") };
  });

  await test("导出文件内容完整：条数 / 排序标记 / BOM / 降序", async () => {
    assert(searchJson && fs.existsSync(searchJson), "需先完成搜索导出");
    const json = JSON.parse(fs.readFileSync(searchJson, "utf8"));
    eq(json.type, "search", "meta.type");
    eq(json.keyword, "保温杯", "meta.keyword");
    eq(json.sales_sorted, true, "meta.sales_sorted");
    assert(json.count >= 20, `落盘条数：${json.count}`);

    const csv = fs.readFileSync(searchCsv, "utf8");
    eq(csv.charCodeAt(0), 0xfeff, "CSV 带 UTF-8 BOM");
    const lines = csv.trim().split("\r\n");
    eq(lines.length, json.count + 1, "CSV 行数 = 表头 + 数据");

    const vals = json.data.map((x) => x.sales_value || 0);
    let desc = true;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] > vals[i - 1]) {
        desc = false;
        break;
      }
    }
    assert(desc, "落盘结果应按销量降序");
    return { count: json.count, desc };
  });

  await test("搜索期间的互斥锁：并发任务被拒绝", async () => {
    const raw = await evalInPage(
      `(async function(){
         var p1 = window.api.runSearch({ keyword: "保温杯", sortBySales: false, maxItems: 20 });
         await new Promise(function(r){ setTimeout(r, 1500); });
         var rejected = null;
         try { await window.api.startBrowser(); } catch (e) { rejected = e.message; }
         var r1 = await p1;
         return JSON.stringify({ rejected: rejected, count: r1.count });
       })()`,
      120000
    );
    const s = JSON.parse(raw);
    assert(s.rejected && /正在执行/.test(s.rejected), `并发调用应被拒绝，实际：${s.rejected}`);
    assert(s.count > 0, "首个搜索仍应正常完成");
    await waitIdle();
    return { rejected: s.rejected, firstSearchCount: s.count };
  });
}

async function suiteDetail() {
  await test("点击表格行的「详情」按钮能触发抓取", async () => {
    // 真实用户操作：点第一行的"详情"按钮
    await evalInPage(
      `(function(){
         var tr = document.querySelectorAll("#gridBody tr")[0];
         var btns = tr.querySelectorAll("button");
         for (var i=0;i<btns.length;i++){ if (btns[i].textContent.trim() === "详情") { btns[i].click(); return "clicked"; } }
         return "not-found";
       })()`
    );
    await cdp.sleep(400);
    const busyShown = await evalInPage(
      `(function(){ var b=document.getElementById("busy"); return !!(b && !b.classList.contains("hidden")); })()`
    );
    assert(busyShown, "点击后应进入忙状态");

    await waitIdle(120000);
    const ui = JSON.parse(
      await evalInPage(
        `JSON.stringify({ foot: document.getElementById("foot").textContent, log: document.getElementById("log").textContent })`
      )
    );
    if (!/详情：/.test(ui.foot)) {
      throw asSkip(new Error(`${ui.foot.trim()} | ${ui.log.slice(-200)}`), "点击「详情」按钮");
    }
    assert(/形态=/.test(ui.log), "日志应含页面形态");
    return { foot: ui.foot.slice(0, 40) };
  });

  await test("detail:fetch 参数校验：非法链接给出中文可读提示", async () => {
    const raw = await evalInPage(
      `(async function(){
         var out = {};
         for (const v of ["", "javascript:alert(1)", null]) {
           try { await window.api.fetchDetail({ link: v }); out[String(v)] = "（未拒绝）"; }
           catch (e) { out[String(v)] = e.message; }
         }
         return JSON.stringify(out);
       })()`,
      60000
    );
    const s = JSON.parse(raw);
    for (const [k, msg] of Object.entries(s)) {
      assert(/商品链接无效/.test(msg), `入参 ${JSON.stringify(k)} 应被拒绝并给出中文提示，实际：${msg}`);
      assert(!/Cannot navigate|CdpError/.test(msg), `不应把底层 CDP 报错抛给用户：${msg}`);
    }
    return s;
  });

  await test("detail:fetch 直调返回完整字段", async () => {
    await waitIdle();
    let d;
    try {
      d = await callApi("fetchDetail", { link: ITEM }, 120000);
    } catch (e) {
      throw asSkip(e, "detail:fetch 直调");
    }
    assert(d.title && d.title.length > 4, `标题：${d.title}`);
    assert(/^[\d.]+$/.test(String(d.price)), `价格：${d.price}`);
    assert(!/\n/.test(String(d.shop)), `店铺名不含换行：${JSON.stringify(d.shop)}`);
    assert(["full", "purchase-panel-only", "punish"].includes(d.page_kind), `形态：${d.page_kind}`);
    return { title: d.title.slice(0, 22), price: d.price, shop: d.shop, kind: d.page_kind };
  });
}

async function suiteReviews() {
  await test("reviews:probe 对当前详情页给出结论", async () => {
    const r = await callApi("probeReviews", undefined, 60000);
    assert(typeof r.ok === "boolean", "ok 是布尔值");
    assert(r.url, "返回 URL");
    if (!r.ok) assert(r.reason && r.reason.length > 6, `需给出原因：${r.reason}`);
    return { ok: r.ok, doc_h: r.doc_h, reason: (r.reason || "").slice(0, 44) };
  });

  await test("reviews:fetch 优雅降级：快速返回原因而非卡死", async () => {
    const t0 = Date.now();
    const r = await callApi("fetchReviews", { link: ITEM, maxItems: 20 }, 150000);
    const cost = Date.now() - t0;
    eq(r.ok, false, "当前应失败");
    assert(r.reason, "必须给出可读原因");
    // 两种可接受的"优雅失败"：① 详情页没有评价模块；② 详情页本身被风控挡住。
    // 关键不是具体哪种原因，而是「快速失败 + 中文可读原因」，绝不能卡到超时。
    assert(
      /评价|风控|验证|限流|详情页/.test(r.reason),
      `原因应可读且与评价/风控相关，实际：${r.reason}`
    );
    assert(cost < 45000, `不应耗满超时（实际 ${cost}ms）`);
    await waitIdle();
    const log = await evalInPage(`document.getElementById("log").textContent`);
    assert(/评价/.test(log), "日志里应留下评价相关记录");
    return { costMs: cost, reason: r.reason.slice(0, 44) };
  });
}

async function suiteBatch() {
  await test("点击「批量抓前 N 条详情」→ 抓取并落盘", async () => {
    const rows = await evalInPage(`document.querySelectorAll("#gridBody tr").length`);
    assert(rows >= 2, `批量依赖搜索结果，当前表格 ${rows} 行`);

    await evalInPage(
      `(function(){
         document.getElementById("batchN").value = "2";
         document.getElementById("batchReviews").checked = true;
         document.getElementById("btnBatch").click();
         return "clicked";
       })()`
    );
    await cdp.sleep(700);
    const busyShown = await evalInPage(
      `(function(){ var b=document.getElementById("busy"); return !!(b && !b.classList.contains("hidden")); })()`
    );
    assert(busyShown, "点击批量后应进入忙状态");
    assert(await evalInPage(`document.getElementById("btnBatch").disabled`), "忙时批量按钮应被禁用");

    await waitIdle(300000);

    const ui = JSON.parse(
      await evalInPage(
        `JSON.stringify({
           foot: document.getElementById("foot").textContent,
           log: document.getElementById("log").textContent
         })`
      )
    );
    assert(/批量完成/.test(ui.foot), `底栏应显示批量完成：${ui.foot}`);
    const dm = ui.foot.match(/详情\s*(\d+)/);
    const rm = ui.foot.match(/评价\s*(\d+)/);
    if (!dm || Number(dm[1]) < 1) {
      // 全被风控挡住时不该伪装成通过——标 SKIP 并保留原始原因（日志里会有具体原因）
      throw asSkip(new Error(`${ui.foot.trim()} | ${ui.log.slice(-200)}`), "批量抓详情");
    }
    eq(Number(rm && rm[1]), 0, "评价不可用时应为 0 而非报错");

    const fm = ui.log.match(/详情已导出：(.+\.csv)/);
    assert(fm, "日志应给出详情导出路径");
    const csvPath = fm[1].trim();
    const jsonPath = csvPath.replace(/\.csv$/, ".json");
    assert(fs.existsSync(csvPath), `详情 CSV 应落盘：${csvPath}`);
    assert(fs.existsSync(jsonPath), `详情 JSON 应落盘：${jsonPath}`);

    const json = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    eq(json.count, Number(dm[1]), "落盘条数与界面统计一致");
    assert(json.data[0].title, "含标题");
    assert(json.data[0].search_sales_text, "含搜索页销量（跨表字段）");
    return { foot: ui.foot.slice(0, 40), details: Number(dm[1]), reviews: Number(rm[1]) };
  });
}

async function suiteEvents() {
  await test("onLog / onProgress 推送通道可用", async () => {
    await evalInPage(
      `(function(){ window.__t = { log: 0, prog: 0 };
         window.api.onLog(function(){ window.__t.log++; });
         window.api.onProgress(function(){ window.__t.prog++; });
         return "hooked"; })()`
    );
    // 触发一次会打日志且有 busy 进度的操作
    await callApi("startBrowser", undefined, 60000);
    await cdp.sleep(700);
    const t = JSON.parse(await evalInPage(`JSON.stringify(window.__t)`));
    assert(t.log > 0, `应收到主进程日志，实际 ${t.log} 条`);
    assert(t.prog > 0, `应收到进度事件，实际 ${t.prog} 条`);
    return t;
  });

  await test("shell:reveal 对不存在的路径无害化处理", async () => {
    // 刻意不触发 shell:open（会真的唤起系统浏览器）；只验证 reveal 会做存在性判断
    const r = await callApi("reveal", "C:\\definitely\\not\\exist\\x.csv");
    eq(r, undefined, "路径不存在时应静默返回");
    return { ok: true };
  });
}

// ————————————————————— 主流程 —————————————————————

async function main() {
  console.log("=".repeat(64));
  console.log("淘宝采集器 · GUI / IPC 层端到端测试");
  console.log("=".repeat(64));

  const t0 = Date.now();
  try {
    await startApp();
  } catch (e) {
    console.error("\n应用启动失败：" + e.message);
    stopApp();
    process.exit(2);
  }

  await suiteShell();
  await suiteInitAndEnv();
  await suiteSearch();
  await suiteDetail();
  await suiteReviews();
  await suiteBatch();
  await suiteEvents();

  const cost = ((Date.now() - t0) / 1000).toFixed(1);
  console.log("\n" + "=".repeat(64));
  console.log(`结果：${pass} 通过 / ${fail} 失败${skip ? ` / ${skip} 跳过（风控）` : ""}   （耗时 ${cost}s）`);
  if (skips.length) {
    console.log("\n跳过明细（淘宝风控，非产品缺陷）：");
    skips.forEach((s) => console.log("  ⚠ " + s));
  }
  if (failures.length) {
    console.log("\n失败明细：");
    failures.forEach((f) => console.log("  ✘ " + f));
  }
  console.log("=".repeat(64));

  stopApp();
  await cdp.sleep(1200);
  process.exit(fail ? 1 : 0);
}

process.on("SIGINT", () => {
  stopApp();
  process.exit(130);
});

main().catch((e) => {
  console.error("\n测试框架异常：", e.stack || e.message);
  stopApp();
  process.exit(2);
});
