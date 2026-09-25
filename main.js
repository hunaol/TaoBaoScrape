// Electron 主进程：窗口 + IPC + 抓取任务编排
const path = require("path");
const fs = require("fs");
const os = require("os");
const { app, BrowserWindow, ipcMain, shell, dialog } = require("electron");

const browser = require("./src/browser");
const cdp = require("./src/cdp");
const session = require("./src/session");
const ex = require("./src/export");
const { TaobaoSession } = require("./src/scraper");

let win = null;
let taobao = null;
let busy = false;
let lastDetailAt = 0;

const OUTPUT_DIR = path.join(os.homedir(), "TaobaoInsight-data");
const DETAIL_COOLDOWN_MS = 15000; // 两次详情页访问的最小间隔，降风控概率

function log(...args) {
  const msg = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a)))
    .join(" ");
  if (win && !win.isDestroyed()) win.webContents.send("log", msg);
  console.log("[taobao]", msg);
}

function progress(payload) {
  if (win && !win.isDestroyed()) win.webContents.send("progress", payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 640,
    title: "淘宝销量/评价采集器",
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, "ui", "index.html"));
  win.on("closed", () => {
    win = null;
  });
}

function getSession() {
  if (!taobao) taobao = new TaobaoSession({ log });
  return taobao;
}

/** 保证浏览器已启动（不打开任何业务页） */
async function ensureBrowserReady() {
  const r = await browser.ensureBrowser({ log });
  log(`浏览器就绪（端口 ${r.port}）`);
  return r;
}

async function withBusy(label, fn) {
  if (busy) throw new Error("有任务正在执行，请等待完成");
  busy = true;
  progress({ busy: true, label });
  try {
    return await fn();
  } finally {
    busy = false;
    progress({ busy: false, label });
  }
}

/** 详情页访问节流 */
async function detailGate() {
  const gap = Date.now() - lastDetailAt;
  if (gap < DETAIL_COOLDOWN_MS) {
    const wait = DETAIL_COOLDOWN_MS - gap;
    log(`限速：等待 ${Math.round(wait / 1000)}s 再打开下一个商品页`);
    await cdp.sleep(wait);
  }
  lastDetailAt = Date.now();
}

ipcMain.handle("env:openOutput", async () => {
  ex.ensureDir(OUTPUT_DIR);
  await shell.openPath(OUTPUT_DIR);
  return OUTPUT_DIR;
});

ipcMain.handle("env:outputDir", () => ex.ensureDir(OUTPUT_DIR));
ipcMain.handle("env:profileDir", () => browser.defaultProfileDir());

ipcMain.handle("browser:start", () =>
  withBusy("启动浏览器", async () => {
    const r = await ensureBrowserReady();
    return { ok: true, port: r.port, launched: r.launched, exe: r.exe || "" };
  })
);

ipcMain.handle("login:open", () =>
  withBusy("打开登录页", async () => {
    await ensureBrowserReady();
    const r = await session.openLoginPage({ log });
    log("已打开淘宝登录页，请在弹出的浏览器窗口里完成登录");
    return r;
  })
);

ipcMain.handle("login:state", async () => {
  try {
    await ensureBrowserReady();
    return await session.getLoginState({ log });
  } catch (e) {
    return { logged_in: false, error: e.message };
  }
});

ipcMain.handle("login:wait", () =>
  withBusy("等待登录", async () => {
    await ensureBrowserReady();
    const st = await session.waitForLogin({
      log,
      timeoutMs: 300000,
      onTick: (s) => progress({ login: s }),
    });
    if (st.logged_in) log(`登录成功：${st.nick || st.user_id}`);
    else log("等待登录超时（5 分钟），可稍后点『检查登录』");
    return st;
  })
);

ipcMain.handle("search:run", (_e, { keyword, sortBySales, maxItems }) =>
  withBusy("搜索", async () => {
    const kw = String(keyword || "").trim();
    if (!kw) throw new Error("请输入关键词");
    await ensureBrowserReady();
    const s = getSession();

    let data = await s.searchByKeyword(kw);
    log(`搜索「${kw}」得到 ${data.count} 条`);

    if (sortBySales) {
      const r = await s.sortBySales();
      if (r.ok) {
        log(`销量排序已生效（第 ${r.attempts} 次点击，口径：${r.note || "人收货"}）`);
        data = await s.fetchResults(maxItems || 60);
      } else {
        log(`销量排序未生效：${r.reason}；改为在本页结果内按销量降序`);
        data.items.sort((a, b) => (b.sales_value || 0) - (a.sales_value || 0));
        data.items.forEach((x, i) => (x.rank = i + 1));
      }
    }

    const save = ex.saveAll({
      dir: OUTPUT_DIR,
      basename: `search-${kw}`,
      rows: data.items,
      columns: ex.SEARCH_COLUMNS,
      meta: { type: "search", keyword: kw, url: data.url, sales_sorted: !!sortBySales },
    });
    log(`已导出：${save.csv}`);
    return { keyword: kw, url: data.url, count: data.count, items: data.items, files: save };
  })
);

ipcMain.handle("detail:fetch", (_e, { link }) =>
  withBusy("打开商品", async () => {
    if (!/^https?:\/\//.test(String(link || ""))) {
      throw new Error("商品链接无效，请先在搜索结果里选择一个商品");
    }
    await ensureBrowserReady();
    const s = getSession();
    await detailGate();
    await s.openItem(link);
    const d = await s.fetchDetail();
    log(`详情：${d.title.slice(0, 40)} | 价格=${d.price || "-"} | 销量=${d.sales_text || "-"} | 页面形态=${d.page_kind}`);
    return d;
  })
);

ipcMain.handle("reviews:probe", () =>
  withBusy("检测评价区", async () => {
    const s = getSession();
    const r = await s.probeReviewAvailability();
    log(r.ok ? "检测到评价模块" : `评价不可用：${r.reason}`);
    return r;
  })
);

ipcMain.handle("reviews:fetch", (_e, { link, maxItems = 20 }) =>
  withBusy("抓评价", async () => {
    if (!/^https?:\/\//.test(String(link || ""))) {
      throw new Error("商品链接无效，请先在搜索结果里选择一个商品");
    }
    await ensureBrowserReady();
    const s = getSession();
    await detailGate();
    await s.openItem(link);
    const detail = await s.fetchDetail();
    log(`商品：${detail.title.slice(0, 40)}（页面形态：${detail.page_kind}）`);

    if (detail.punished) {
      const msg = "详情页触发了淘宝风控验证，请在浏览器窗口里手动完成验证后重试";
      log(msg);
      return { ok: false, reason: msg, need_verify: true, detail };
    }

    const opened = await s.openReviews();
    if (!opened.ok) {
      log(`评价抓取失败：${opened.reason}`);
      return { ok: false, reason: opened.reason, page_kind: opened.page_kind, detail };
    }

    const rv = await s.fetchReviews();
    if (rv.error) {
      log(`评价抓取失败：${rv.error}`);
      return { ok: false, reason: rv.error, detail };
    }
    const rows = (rv.reviews || [])
      .slice(0, maxItems)
      .map((r) => ({ ...r, item_id: detail.item_id, item_title: detail.title }));
    log(`抓到 ${rows.length} 条评价（筛选标签：${(rv.stat_lines || []).slice(0, 10).join(" / ") || "无"}）`);

    const save = rows.length
      ? ex.saveAll({
          dir: OUTPUT_DIR,
          basename: `reviews-${detail.item_id || "item"}`,
          rows,
          columns: ex.REVIEW_COLUMNS,
          meta: { type: "reviews", item_id: detail.item_id, item_title: detail.title },
        })
      : null;
    if (save) log(`已导出：${save.csv}`);
    return { ok: true, count: rows.length, rows, detail, files: save, stat_lines: rv.stat_lines || [], total_text: rv.total_text || "" };
  })
);

/** 批量：对搜索结果前 N 条逐个抓销量+评价，边抓边落盘 */
ipcMain.handle("batch:run", (_e, { items, withReviews, reviewsPerItem }) =>
  withBusy("批量抓取", async () => {
    await ensureBrowserReady();
    const s = getSession();
    const details = [];
    const reviews = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      progress({ batch: { index: i + 1, total: items.length, title: it.title } });
      log(`—— [${i + 1}/${items.length}] ${String(it.title).slice(0, 34)} ——`);
      try {
        await detailGate();
        await s.openItem(it.link);
        const d = await s.fetchDetail();
        details.push({ ...d, search_sales_text: it.sales_text, search_price: it.price });
        log(`  详情：价格=${d.price || "-"} 销量=${d.sales_text || "-"} 形态=${d.page_kind}`);

        if (withReviews) {
          if (d.punished) {
            log("  触发风控，跳过该商品的评价");
          } else {
            const opened = await s.openReviews();
            if (!opened.ok) {
              log(`  评价跳过：${opened.reason}`);
            } else {
              const rv = await s.fetchReviews();
              const rows = (rv.reviews || []).slice(0, reviewsPerItem || 20);
              rows.forEach((r) => reviews.push({ ...r, item_id: d.item_id, item_title: d.title }));
              log(`  评价 ${rows.length} 条`);
            }
          }
        }
      } catch (e) {
        log(`  出错：${e.message}`);
      }
    }

    const out = {};
    if (details.length) {
      out.details = ex.saveAll({
        dir: OUTPUT_DIR,
        basename: "details-batch",
        rows: details,
        columns: [
          { key: "item_id", label: "商品ID" },
          { key: "title", label: "标题" },
          { key: "price", label: "详情页价格" },
          { key: "sales_text", label: "详情页销量" },
          { key: "search_sales_text", label: "搜索页销量" },
          { key: "search_price", label: "搜索页价格" },
          { key: "shop", label: "店铺" },
          { key: "page_kind", label: "页面形态" },
          { key: "url", label: "链接" },
        ],
        meta: { type: "details", count: details.length },
      });
      log(`详情已导出：${out.details.csv}`);
    }
    if (reviews.length) {
      out.reviews = ex.saveAll({
        dir: OUTPUT_DIR,
        basename: "reviews-batch",
        rows: reviews,
        columns: ex.REVIEW_COLUMNS,
        meta: { type: "reviews", count: reviews.length },
      });
      log(`评价已导出：${out.reviews.csv}`);
    }
    progress({ batch: null });
    return { details: details.length, reviews: reviews.length, files: out };
  })
);

ipcMain.handle("shell:open", (_e, url) => shell.openExternal(url));
ipcMain.handle("shell:reveal", (_e, p) => {
  if (p && fs.existsSync(p)) shell.showItemInFolder(p);
});

app.whenReady().then(async () => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 关闭时只断开 CDP，不杀浏览器（浏览器里可能有用户自己的标签页）
app.on("before-quit", () => {
  try {
    if (taobao) taobao.close();
  } catch {}
});

process.on("uncaughtException", (e) => log("主进程异常：", e.message));
