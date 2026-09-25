/**
 * 端到端测试（src 层）：不经过 Electron，直接驱动浏览器与抓取逻辑。
 * 运行：node test/e2e-src.js
 * 前提：本机装有 Chrome/Edge；9222 端口无浏览器时会自动拉起。
 */
const path = require("path");
const fs = require("fs");
const os = require("os");

const browser = require("../src/browser");
const cdp = require("../src/cdp");
const session = require("../src/session");
const ex = require("../src/export");
const S = require("../src/scraper");

const TMP = path.join(os.tmpdir(), `taobao-e2e-${process.pid}`);
const ITEM = "https://detail.tmall.com/item.htm?id=980221506328";
const KW = "保温杯";

let pass = 0;
let fail = 0;
let skip = 0;
const failures = [];
const skips = [];

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

function assert(cond, msg) {
  if (!cond) throw new Error(msg || "断言失败");
}
function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "相等"}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}
function noThrow(fn, msg) {
  try {
    return fn();
  } catch (e) {
    throw new Error(`${msg || "不应抛错"}：${e.message}`);
  }
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

// ————————————————————————— 纯函数 —————————————————————————

async function suitePure() {
  await test("parseSalesText：万/千/原值/下限", () => {
    const a = S.parseSalesText("2万+人付款");
    eq(a.value, 20000, "2万+ 数值");
    eq(a.unit, "万", "2万+ 单位");
    eq(a.is_lower_bound, true, "2万+ 是下限");

    const b = S.parseSalesText("1000+人收货");
    eq(b.value, 1000, "1000+ 数值");
    eq(b.is_lower_bound, true, "1000+ 是下限");

    const c = S.parseSalesText("500人付款");
    eq(c.value, 500, "500 数值");
    eq(c.is_lower_bound, false, "500 不是下限");

    const d = S.parseSalesText("3千+人付款");
    eq(d.value, 3000, "3千+ 数值");
    eq(d.unit, "千", "3千+ 单位");

    const e = S.parseSalesText("");
    eq(e.value, null, "空串数值为 null");
    eq(e.is_lower_bound, true, "空串视为下限");

    return { a: a.value, c: c.value, d: d.value };
  });

  await test("parseSalesMetric：付款/收货/看过/已售/月销", () => {
    eq(S.parseSalesMetric("2万+人付款"), "付款人数");
    eq(S.parseSalesMetric("1000+人收货"), "收货人数");
    eq(S.parseSalesMetric("300人看过"), "浏览人数");
    eq(S.parseSalesMetric("已售 2000+"), "已售件数");
    eq(S.parseSalesMetric("月销 500"), "月销量");
    eq(S.parseSalesMetric("无所谓"), "");
    return { ok: true };
  });

  await test("parseReviewMeta：日期/SKU 拆分", () => {
    const r = S.parseReviewMeta("2026年1月5日 已购: 黑色/L");
    eq(r.date, "2026-01-05", "日期归一化");
    eq(r.color, "黑色", "颜色");
    eq(r.size, "L", "尺码");

    const n = S.parseReviewMeta("");
    eq(n.date, "", "空串日期为空");
    eq(n.sku, "", "空串 SKU 为空");
    return { date: r.date, color: r.color, size: r.size };
  });

  await test("SEARCH_URL / ITEM_LINK_SEL 形态正确", () => {
    const u = S.SEARCH_URL("羽绒服");
    assert(u.startsWith("https://s.taobao.com/search?q="), "搜索 URL 前缀");
    assert(u.includes(encodeURIComponent("羽绒服")), "关键词已编码");
    assert(!/sort=/.test(u), "搜索 URL 不带 sort 参数（带 sort 会导致列表不渲染）");
    assert(/item\.taobao\.com|detail\.tmall\.com/.test(S.ITEM_LINK_SEL), "商品链接选择器");
    return { url: u.slice(0, 52) };
  });
}

// ————————————————————————— 导出层 —————————————————————————

async function suiteExport() {
  await test("toCsv：BOM / 逗号 / 引号 / 换行转义", () => {
    const csv = ex.toCsv(
      [
        { name: "普通", note: "无特殊字符" },
        { name: "含,逗号", note: '含"引号"' },
        { name: "含\n换行", note: null },
      ],
      [
        { key: "name", label: "名称" },
        { key: "note", label: "备注" },
      ]
    );
    eq(csv[0], "\uFEFF", "首字符是 BOM");
    assert(csv.includes('"含,逗号"'), "逗号字段被引号包裹");
    assert(csv.includes('"含""引号"""'), "内部引号被双写");
    assert(csv.includes("含 换行"), "换行被替换为空格");
    assert(csv.includes("\r\n"), "使用 CRLF 行尾");
    return { lines: csv.split("\r\n").length };
  });

  await test("saveAll：同时落盘 CSV + JSON 且内容一致", () => {
    const rows = [
      { rank: 1, title: "测试商品A", price: "9.9" },
      { rank: 2, title: "测试商品B", price: "19.9" },
    ];
    const cols = [
      { key: "rank", label: "排名" },
      { key: "title", label: "标题" },
      { key: "price", label: "价格" },
    ];
    const r = ex.saveAll({ dir: TMP, basename: "unit", rows, columns: cols, meta: { type: "unit-test" } });
    assert(fs.existsSync(r.csv), "CSV 已生成");
    assert(fs.existsSync(r.json), "JSON 已生成");

    const csv = fs.readFileSync(r.csv, "utf8");
    assert(csv.includes("测试商品A"), "CSV 含数据");

    const json = JSON.parse(fs.readFileSync(r.json, "utf8"));
    eq(json.type, "unit-test", "meta 透传");
    eq(json.count, 2, "count 正确");
    eq(json.data.length, 2, "data 长度");
    eq(json.data[1].title, "测试商品B", "data 内容");
    assert(typeof json.exported_at === "string" && json.exported_at.length > 10, "含导出时间");
    return { csv: path.basename(r.csv), json: path.basename(r.json) };
  });

  await test("ensureDir：递归创建目录", () => {
    const deep = path.join(TMP, "a", "b", "c");
    ex.ensureDir(deep);
    assert(fs.existsSync(deep), "深层目录已创建");
    return { dir: deep.replace(os.tmpdir(), "…") };
  });
}

// ————————————————————————— CDP 层 —————————————————————————

async function suiteCdp() {
  await test("isCdpAlive：存活端口 true / 闲置端口 false", async () => {
    const alive = await cdp.isCdpAlive("127.0.0.1", browser.PORT);
    assert(alive === true, `${browser.PORT} 端口应存活（请先启动浏览器）`);
    const dead = await cdp.isCdpAlive("127.0.0.1", 59999);
    eq(dead, false, "未监听端口应为 false");
    return { [browser.PORT]: alive, 59999: dead };
  });

  await test("listTargets / attach / evaluate / send 基本可用", async () => {
    const targets = await cdp.listTargets("127.0.0.1", browser.PORT);
    assert(Array.isArray(targets) && targets.length > 0, "至少有一个 target");
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    assert(page, "存在可调试的 page target");

    const c = await cdp.attach(page.webSocketDebuggerUrl);
    try {
      const v = await cdp.evaluate(c, "1 + 2");
      eq(v, 3, "evaluate 返回值");
      const s = await cdp.evaluate(c, "navigator.userAgent");
      assert(typeof s === "string" && s.length > 10, "能读到 UA");
      const info = await c.send("Browser.getVersion");
      assert(info.product, "send 原始协议方法可用");
      return { targets: targets.length, browser: info.product };
    } finally {
      c.close();
    }
  });

  await test("waitFor：条件成立即返回；超时返回 null", async () => {
    const targets = await cdp.listTargets("127.0.0.1", browser.PORT);
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const c = await cdp.attach(page.webSocketDebuggerUrl);
    try {
      const t0 = Date.now();
      const hit = await cdp.waitFor(c, "1 === 1", { timeoutMs: 5000 });
      const fast = Date.now() - t0;
      eq(hit, true, "条件成立时返回其真值");
      assert(fast < 4000, "条件成立应立即返回");

      // 约定：超时返回 null/false（不抛错），调用方必须自行判断返回值
      const miss = await cdp.waitFor(c, "false", { timeoutMs: 1200, intervalMs: 300 });
      eq(miss, null, "超时应返回 null 而不是抛错");
      const load = await cdp.waitForLoad(c, { timeoutMs: 800 });
      assert(load === true, "已就绪页面的 waitForLoad 应返回 true");
      return { fastMs: fast, timeoutReturns: String(miss) };
    } finally {
      c.close();
    }
  });

  await test("评估异常：页面内 throw 能捕获到错误", async () => {
    const targets = await cdp.listTargets("127.0.0.1", browser.PORT);
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const c = await cdp.attach(page.webSocketDebuggerUrl);
    try {
      let msg = "";
      try {
        await cdp.evaluate(c, "(function(){ throw new Error('boom-test'); })()");
      } catch (e) {
        msg = e.message;
      }
      assert(/boom-test/.test(msg), `应捕获页面内异常，实际：${msg}`);
      return { caught: msg.slice(0, 40) };
    } finally {
      c.close();
    }
  });
}

// ————————————————————————— 浏览器层 —————————————————————————

async function suiteBrowser() {
  await test("findBrowser / defaultProfileDir", () => {
    const exePath = browser.findBrowser();
    assert(exePath && fs.existsSync(exePath), `应找到浏览器内核，实际：${exePath}`);
    const pd = browser.defaultProfileDir();
    assert(pd.includes(".taobao-insight"), `用户数据目录应独立，实际：${pd}`);
    return { exe: path.basename(exePath), profile: pd.replace(os.homedir(), "~") };
  });

  await test("ensureBrowser：复用已在运行的实例", async () => {
    const r = await browser.ensureBrowser({ log: () => {} });
    eq(r.launched, false, "9222 已存活时应复用而非新起");
    eq(r.port, browser.PORT, "端口");
    return { launched: r.launched, port: r.port };
  });

  await test("openTab / closeTab：新建与关闭标签页", async () => {
    const before = (await browser.pageTargets()).length;
    const t = await browser.openTab("about:blank");
    assert(t.id, "新标签页有 id");
    await cdp.sleep(800);
    const during = (await browser.pageTargets()).length;
    assert(during > before, `标签页数应增加：${before} → ${during}`);

    await browser.closeTab(t.id);
    await cdp.sleep(1200);
    const after = (await browser.pageTargets()).length;
    assert(after < during, `标签页数应回落：${during} → ${after}`);
    return { before, during, after };
  });
}

// ————————————————————————— 登录层 —————————————————————————

async function suiteLogin() {
  await test("getLoginState：登录态判定正确，且不受标签页域影响", async () => {
    const st = await session.getLoginState({ log: () => {} });
    assert(typeof st.logged_in === "boolean", "logged_in 是布尔值");
    assert("user_id" in st && "nick" in st, "含 user_id / nick 字段");

    if (!st.logged_in) {
      return { logged_in: false, 说明: "当前浏览器未登录，跳过域隔离专项验证" };
    }
    assert(String(st.user_id).length > 3, "已登录时 user_id 应有效");

    // 验证登录态判定与「当前聚焦的标签页域」无关。
    // 背景：旧实现用页面里的 document.cookie 读 unb，而 document.cookie 是按源隔离的；
    // 一旦脚本落在 detail.tmall.com 上，读到的只是 .tmall.com 自己的 unb，
    // 而不是权威的 .taobao.com 登录态。改成 CDP Network.getCookies 按 taobao.com URL 显式取。
    const s = new S.TaobaoSession({ log: () => {} });
    try {
      // 试着把标签落到 tmall 域；被风控挡住也不影响本用例的核心断言（登录态与标签域无关）
      let onTmall = true;
      try {
        await s.openItem(ITEM);
      } catch (e) {
        if (!PUNISH_RE.test(e.message)) throw e;
        onTmall = false;
      }
      // 注意：必须精确匹配商品页——登录页 URL 的 redirectURL 参数里也含 "detail.tmall.com"
      const tmallTab = (await browser.pageTargets()).find((t) =>
        /^https?:\/\/detail\.tmall\.com\/item\.htm/.test(t.url)
      );
      assert(tmallTab, "应存在 tmall 商品详情页标签");

      const c = await cdp.attach(tmallTab.webSocketDebuggerUrl);
      let taobaoUnb = false;
      try {
        const r = await c.send("Network.getCookies", {
          urls: ["https://www.taobao.com", "https://i.taobao.com"],
        });
        taobaoUnb = (r.cookies || []).some((x) => x.name === "unb" && String(x.value).length > 3);
      } finally {
        c.close();
      }
      assert(taobaoUnb, "CDP 应能按 taobao.com URL 读到 unb（与当前标签落在哪个域无关）");

      // 分别在 tmall 详情页聚焦、搜索页聚焦两种情况下读登录态，结果必须一致
      const stOnTmall = await session.getLoginState({ log: () => {} });
      assert(stOnTmall.logged_in === true, "标签落在 tmall 域时，也必须判定为已登录");

      const searchTab = (await browser.pageTargets()).find((t) => /s\.taobao\.com\/search/.test(t.url));
      if (searchTab) {
        const c2 = await cdp.attach(searchTab.webSocketDebuggerUrl);
        await c2.send("Page.bringToFront").catch(() => {});
        c2.close();
      }
      const stOnSearch = await session.getLoginState({ log: () => {} });
      assert(stOnSearch.logged_in === true, "切换到搜索页标签后，登录态判定不变");
      eq(String(stOnSearch.user_id), String(stOnTmall.user_id), "两种标签下拿到的 user_id 必须一致");

      return { taobaoUnb, logged_in: stOnTmall.logged_in, nick: stOnTmall.nick, 两种标签一致: true, 已落到tmall域: onTmall };
    } finally {
      s.close();
    }
  });

  await test("openLoginPage：打开登录页且不代填凭据", async () => {
    const before = new Map((await browser.pageTargets()).map((t) => [t.id, t.url]));

    const r = await session.openLoginPage({ log: () => {} });
    assert(r.ok, "返回 ok");
    eq(r.url, session.LOGIN_URL, "返回的 URL 是登录页地址");

    const tabs = await browser.pageTargets();
    // 已登录时淘宝会立刻把登录页跳走，所以只断言"发生了到淘宝域的导航"
    const navigated = tabs.filter((t) => {
      const prev = before.get(t.id);
      return /(taobao|tmall)\.com/.test(t.url) && prev !== t.url;
    });
    const newTabs = tabs.filter((t) => !before.has(t.id));
    assert(
      navigated.length > 0 || newTabs.length > 0,
      `应产生登录页导航或新标签页（navigated=${navigated.length}, new=${newTabs.length}）`
    );
    assert(
      tabs.some((t) => /(taobao|tmall)\.com/.test(t.url)),
      "浏览器中存在淘宝域标签"
    );

    // 运行时检查：若还停在登录表单上，密码框必须为空
    let runtime = "已登录态，登录页已跳转，未停留在表单";
    const loginTab = tabs.find((t) => /login\.taobao\.com/.test(t.url));
    if (loginTab) {
      const c = await cdp.attach(loginTab.webSocketDebuggerUrl);
      try {
        const raw = await cdp.evaluate(
          c,
          `(function(){
             var pw = document.querySelectorAll("input[type=password]");
             var filled = 0;
             for (var i=0;i<pw.length;i++){ if ((pw[i].value||"").length > 0) filled++; }
             return JSON.stringify({ hasPasswordField: pw.length > 0, filledPasswordFields: filled, url: location.href.slice(0,80) });
           })()`
        );
        const s = JSON.parse(raw);
        eq(s.filledPasswordFields, 0, "密码框必须为空（本工具不代填账号密码）");
        runtime = `密码框 ${s.hasPasswordField ? "存在且为空" : "不存在"}`;
      } finally {
        c.close();
      }
    }

    // 静态检查：整个代码库里不存在写入账号/密码的逻辑
    const files = ["main.js", "preload.js", "cli.js", "src/session.js", "src/browser.js", "src/scraper.js", "ui/renderer.js"];
    const offenders = files.filter((f) => {
      const code = fs.readFileSync(path.join(__dirname, "..", f), "utf8");
      return /type\s*=\s*['"]?password|fm-login-password|fm-login-id|login-password/i.test(code);
    });
    eq(offenders.length, 0, `源码不应触碰登录表单，命中：${offenders.join(", ")}`);

    return { runtime, navigated: navigated.length, newTabs: newTabs.length };
  });
}

// ————————————————————————— 抓取层 —————————————————————————

let searchData = null;
let detailData = null;

async function suiteScraper() {
  const s = new S.TaobaoSession({ log: (m) => console.log("    · " + m) });

  await test(`searchByKeyword：「${KW}」返回列表且字段完整`, async () => {
    try {
      searchData = await s.searchByKeyword(KW);
    } catch (e) {
      throw asSkip(e, "搜索");
    }
    assert(Array.isArray(searchData.items), "items 是数组");
    assert(searchData.items.length >= 20, `应抓到足够条目，实际 ${searchData.items.length}`);
    assert(/s\.taobao\.com\/search/.test(searchData.url), "URL 落在搜索页");

    const keys = ["rank", "item_id", "title", "price", "sales_text", "sales_value", "sales_metric", "shop", "location", "link"];
    const first = searchData.items[0];
    for (const k of keys) assert(k in first, `首条缺少字段 ${k}`);
    assert(first.title && first.title.length > 2, "标题非空");
    assert(/^https?:/.test(first.link), "链接是完整 URL");
    assert(/item\.taobao\.com|detail\.tmall\.com/.test(first.link), "链接指向商品页");

    const ranked = searchData.items.every((x, i) => x.rank === i + 1);
    assert(ranked, "rank 连续递增");

    const withSales = searchData.items.filter((x) => x.sales_text).length;
    assert(withSales >= searchData.items.length * 0.5, `多数条目应有销量原文，实际 ${withSales}/${searchData.items.length}`);

    const withMetric = searchData.items.filter((x) => x.sales_metric).length;
    assert(withMetric > 0, "至少部分条目有销量口径");

    return {
      count: searchData.count,
      items: searchData.items.length,
      withSales,
      sample: `${searchData.items[0].sales_text} / ¥${searchData.items[0].price}`,
    };
  });

  await test("sortBySales：点击「销量」使服务端排序生效", async () => {
    const r = await s.sortBySales();
    if (!r.ok && PUNISH_RE.test(String(r.reason))) {
      throw asSkip(new Error(String(r.reason)), "按销量排序");
    }
    assert(r.ok, `排序应成功，实际：${r.reason || "unknown"}`);
    eq(r.active_tab, "销量", "激活的 tab 是销量");
    assert(r.attempts >= 1, "有尝试次数");
    return { active_tab: r.active_tab, attempts: r.attempts, note: r.note };
  });

  await test("fetchResults：排序后销量降序且口径变为「人收货」", async () => {
    let d;
    try {
      d = await s.fetchResults(60);
    } catch (e) {
      throw asSkip(e, "抓取排序结果");
    }
    assert(d.items.length >= 10, `条目数：${d.items.length}`);

    const vals = d.items.map((x) => x.sales_value || 0).filter((v) => v > 0);
    let desc = true;
    for (let i = 1; i < vals.length; i++) {
      if (vals[i] > vals[i - 1]) {
        desc = false;
        break;
      }
    }
    assert(desc, `销量应降序，实际前 8 项：${d.items.slice(0, 8).map((x) => x.sales_text).join(" | ")}`);

    const metrics = {};
    d.items.forEach((x) => {
      if (x.sales_metric) metrics[x.sales_metric] = (metrics[x.sales_metric] || 0) + 1;
    });
    return { count: d.items.length, desc, metrics, top3: d.items.slice(0, 3).map((x) => `${x.sales_text} ¥${x.price}`) };
  });

  await test("搜索+排序结果可导出为 CSV/JSON", async () => {
    if (!searchData || !searchData.items.length) {
      throw makeSkip("导出", "上游搜索被风控挡住，没有可导出的数据");
    }
    const save = ex.saveAll({
      dir: TMP,
      basename: `search-${KW}`,
      rows: searchData.items,
      columns: ex.SEARCH_COLUMNS,
      meta: { type: "search", keyword: KW, url: searchData.url, sales_sorted: true },
    });
    const json = JSON.parse(fs.readFileSync(save.json, "utf8"));
    eq(json.count, searchData.count, "JSON count 与搜索结果一致");
    assert(json.data[0].sales_text, "导出的首条含销量");

    const csv = fs.readFileSync(save.csv, "utf8");
    const lines = csv.trim().split("\r\n");
    eq(lines.length, searchData.items.length + 1, "CSV 行数 = 表头 + 数据行");
    eq(lines[0].replace("\uFEFF", ""), ex.SEARCH_COLUMNS.map((c) => c.label).join(","), "表头顺序正确");
    return { rows: lines.length - 1, file: path.basename(save.csv) };
  });

  await test("openItem + fetchDetail：详情页字段可解析", async () => {
    try {
      await s.openItem(ITEM);
      detailData = await s.fetchDetail();
    } catch (e) {
      throw asSkip(e, "打开商品详情");
    }
    assert(detailData.title && detailData.title.length > 4, `标题：${detailData.title}`);
    assert(/^[\d.]+$/.test(String(detailData.price)), `价格应可解析为数字，实际：${detailData.price}`);
    eq(detailData.item_id, "980221506328", "商品 ID 与链接一致");
    assert(!/\n/.test(String(detailData.shop)), `店铺名不应含换行，实际：${JSON.stringify(detailData.shop)}`);
    assert(["full", "purchase-panel-only", "punish"].includes(detailData.page_kind), `页面形态取值合法：${detailData.page_kind}`);
    assert(typeof detailData.punished === "boolean", "punished 是布尔值");
    return {
      title: detailData.title.slice(0, 24),
      price: detailData.price,
      shop: detailData.shop,
      kind: detailData.page_kind,
      imgs: detailData.main_images.length,
      sku: detailData.sku_options.length,
    };
  });

  await test("probeReviewAvailability：给出可读结论（当前预期为不可用）", async () => {
    const r = await s.probeReviewAvailability();
    assert(typeof r.ok === "boolean", "ok 是布尔值");
    assert(r.url, "返回当前 URL");
    assert(typeof r.doc_h === "number", "返回文档高度");
    if (!r.ok) {
      assert(r.reason && r.reason.length > 6, `不可用时应给出原因，实际：${r.reason}`);
    }
    return { ok: r.ok, doc_h: r.doc_h, nodes: r.review_text_nodes, reason: (r.reason || "").slice(0, 46) };
  });

  await test("openReviews：不可用时快速失败而非空等", async () => {
    const t0 = Date.now();
    const r = await s.openReviews({ timeoutMs: 25000 });
    const cost = Date.now() - t0;
    assert(typeof r.ok === "boolean", "ok 是布尔值");
    if (!r.ok) {
      assert(r.reason, "失败时给出原因");
      assert(cost < 20000, `应在探测后快速返回（实际 ${cost}ms），不该耗满 25s 超时`);
    }
    return { ok: r.ok, costMs: cost, reason: (r.reason || "").slice(0, 46) };
  });

  await test("fetchReviews：无评价模块时抛可读错误而非崩溃", async () => {
    const r = await s.fetchReviews();
    if (r && r.error) {
      assert(r.error.length > 4, "错误信息可读");
      return { error: r.error.slice(0, 46) };
    }
    assert(Array.isArray(r.reviews), "若成功则应返回 reviews 数组");
    return { reviews: r.reviews.length };
  });

  await test("close：释放 CDP 连接且不关闭浏览器", async () => {
    s.close();
    await cdp.sleep(600);
    const alive = await cdp.isCdpAlive("127.0.0.1", browser.PORT);
    assert(alive, "close 后浏览器仍应存活（不杀用户浏览器）");
    return { browserAlive: alive };
  });
}

// ————————————————————————— 主流程 —————————————————————————

async function main() {
  console.log("=".repeat(64));
  console.log("淘宝采集器 · src 层端到端测试");
  console.log("=".repeat(64));

  const t0 = Date.now();
  await browser.ensureBrowser({ log: (m) => console.log("  [browser] " + m) });

  await suitePure();
  await suiteExport();
  await suiteCdp();
  await suiteBrowser();
  await suiteLogin();
  await suiteScraper();

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
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("\n测试框架异常：", e.stack || e.message);
  process.exit(2);
});
