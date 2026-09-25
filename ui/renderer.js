// 渲染进程逻辑
const $ = (id) => document.getElementById(id);
let items = [];
let selected = -1;

function log(msg) {
  const el = $("log");
  const t = new Date().toTimeString().slice(0, 8);
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}
function setFoot(s) { $("foot").textContent = s; }
function setBusy(b, label) {
  $("busy").classList.toggle("hidden", !b);
  if (b) $("busy").textContent = `${label || "任务"}执行中…`;
  document.querySelectorAll("button").forEach((x) => (x.disabled = b && x.id !== "btnClear"));
}

function renderGrid(meta) {
  const tb = $("gridBody");
  tb.innerHTML = "";
  items.forEach((it, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="idx">${i + 1}</td>
      <td class="sales">${esc(it.sales_text || "-")}</td>
      <td class="price">¥${esc(it.price || "-")}</td>
      <td class="title">${esc(it.title || "")}</td>
      <td class="shop">${esc(it.shop || "")}</td>
      <td class="loc">${esc(it.location || "")}</td>
      <td class="ops"></td>`;
    const ops = tr.querySelector(".ops");
    const b1 = document.createElement("button");
    b1.textContent = "详情";
    b1.onclick = () => pickAnd(i, () => runDetail());
    const b2 = document.createElement("button");
    b2.textContent = "评价";
    b2.onclick = () => pickAnd(i, () => runReviews());
    const b3 = document.createElement("button");
    b3.textContent = "链接";
    b3.onclick = () => window.api.openUrl(it.link);
    ops.append(b1, b2, b3);
    tr.onclick = (e) => { if (!e.target.closest("button")) pickAnd(i); };
    tb.appendChild(tr);
  });
  if (meta) $("tableMeta").textContent = meta;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function pickAnd(i, after) {
  selected = i;
  $("idx").value = i + 1;
  [...$("gridBody").children].forEach((tr, k) => tr.classList.toggle("sel", k === i));
  if (after) after();
}
function currentItem() {
  const i = selected >= 0 ? selected : Number($("idx").value) - 1;
  if (!items[i]) throw new Error("请先在表格里选一个商品，或先执行搜索");
  return items[i];
}

async function refreshLogin() {
  try {
    applyLogin(await window.api.loginState());
  } catch {
    $("loginDot").className = "dot bad";
    $("loginText").textContent = "登录状态未知";
  }
}

$("btnStart").onclick = async () => {
  try {
    setBusy(true, "启动浏览器");
    const r = await window.api.startBrowser();
    $("browserDot").className = "dot ok";
    $("browserText").textContent = `浏览器就绪 :${r.port}`;
    log(`浏览器${r.launched ? "已启动" : "已复用"}（调试端口 ${r.port}）`);
  } catch (e) {
    $("browserDot").className = "dot bad";
    log("启动失败：" + e.message);
  } finally {
    setBusy(false);
  }
};

$("btnLogin").onclick = async () => {
  try {
    setBusy(true, "打开登录页");
    await window.api.openLogin();
  } catch (e) {
    log("打开登录页失败：" + e.message);
  } finally {
    setBusy(false);
  }
  log("登录页已打开，请在浏览器窗口完成登录（本工具不代填账号密码）");
  setFoot("等待登录…");
  startLoginWatch();
};

// 非阻塞轮询登录状态：不占用 busy 锁，轮询期间仍可搜索
let loginTimer = null;
function startLoginWatch() {
  if (loginTimer) clearInterval(loginTimer);
  loginTimer = setInterval(async () => {
    const s = await window.api.loginState().catch(() => null);
    if (!s) return;
    applyLogin(s);
    if (s.logged_in) {
      clearInterval(loginTimer);
      loginTimer = null;
      log(`登录成功：${s.nick || s.user_id}`);
      setFoot("已登录");
    }
  }, 4000);
}

function applyLogin(s) {
  const ok = !!s.logged_in;
  $("loginDot").className = "dot " + (ok ? "ok" : "bad");
  $("loginText").textContent = ok ? `已登录 ${s.nick || s.user_id}` : "未登录（搜索结果仍可抓）";
}

$("btnCheckLogin").onclick = refreshLogin;
$("btnOutput").onclick = () => window.api.openOutput().then((d) => log("数据目录：" + d));
$("btnClear").onclick = () => ($("log").textContent = "");

$("btnSearch").onclick = async () => {
  const keyword = $("kw").value.trim();
  if (!keyword) return log("请先输入关键词");
  try {
    setBusy(true, "搜索");
    setFoot("搜索中…");
    const r = await window.api.runSearch({
      keyword,
      sortBySales: $("doSort").checked,
      maxItems: Number($("maxItems").value) || 60,
    });
    items = r.items || [];
    selected = -1;
    renderGrid(`「${r.keyword}」共 ${items.length} 条`);
    setFoot(`已导出 ${r.files.csv}`);
    log(`导出完成：${r.files.csv}`);
  } catch (e) {
    log("搜索失败：" + e.message);
  } finally {
    setBusy(false);
  }
};

async function runDetail() {
  const it = currentItem();
  try {
    setBusy(true, "打开商品");
    const d = await window.api.fetchDetail({ link: it.link });
    log(`详情：${d.title}`);
    log(`  价格=${d.price || "-"} 销量=${d.sales_text || "-"} 店铺=${d.shop || "-"} 形态=${d.page_kind}`);
    if (d.page_kind === "purchase-panel-only") {
      log("  提示：新版详情页只有购买面板，不含评价模块（淘宝已改版）");
    }
    if (d.punished) log("  提示：出现风控验证，请在浏览器窗口手动完成验证");
    setFoot(`详情：${d.title}`);
  } catch (e) {
    log("详情失败：" + e.message);
  } finally {
    setBusy(false);
  }
}

async function runReviews() {
  const it = currentItem();
  try {
    setBusy(true, "抓评价");
    const r = await window.api.fetchReviews({ link: it.link, maxItems: Number($("rvCount").value) || 20 });
    if (!r.ok) {
      log("评价未抓到：" + r.reason);
      if (r.need_verify) log("  → 请在浏览器窗口完成滑块验证，然后重试");
      setFoot("评价不可用");
      return;
    }
    log(`抓到 ${r.count} 条评价`);
    (r.rows || []).slice(0, 5).forEach((x) => log(`  · ${x.user || "-"} ${x.date || ""} [${x.sku || ""}] ${String(x.text || "").slice(0, 40)}`));
    if (r.files) log("已导出：" + r.files.csv);
    setFoot(`评价 ${r.count} 条`);
  } catch (e) {
    log("抓评价失败：" + e.message);
  } finally {
    setBusy(false);
  }
}

$("btnDetail").onclick = runDetail;
$("btnReviews").onclick = runReviews;

$("btnProbe").onclick = async () => {
  try {
    setBusy(true, "检测评价区");
    const r = await window.api.probeReviews();
    log(r.ok ? "检测到评价模块，可以尝试抓取" : `评价不可用：${r.reason}`);
    log(`  详情页 URL：${r.url || "-"}  文档高：${r.doc_h || 0}  含"评价"文本数：${r.review_text_nodes || 0}`);
  } catch (e) {
    log("检测失败：" + e.message);
  } finally {
    setBusy(false);
  }
};

$("btnBatch").onclick = async () => {
  if (!items.length) return log("请先搜索");
  const n = Math.min(Number($("batchN").value) || 3, items.length);
  try {
    setBusy(true, "批量抓取");
    log(`开始批量抓取前 ${n} 条…`);
    const r = await window.api.runBatch({
      items: items.slice(0, n),
      withReviews: $("batchReviews").checked,
      reviewsPerItem: Number($("rvCount").value) || 20,
    });
    log(`批量完成：详情 ${r.details} 条，评价 ${r.reviews} 条`);
    setFoot(`批量完成：详情 ${r.details} / 评价 ${r.reviews}`);
  } catch (e) {
    log("批量失败：" + e.message);
  } finally {
    setBusy(false);
  }
};

window.api.onLog((m) => log(m));
window.api.onProgress((p) => {
  if (p.busy !== undefined) setBusy(p.busy, p.label);
  if (p.login) applyLogin(p.login);
  if (p.batch) setFoot(`批量 [${p.batch.index}/${p.batch.total}] ${String(p.batch.title || "").slice(0, 26)}`);
});

// 启动即自动拉起浏览器；未登录则自动弹出登录页
(async () => {
  const dir = await window.api.outputDir();
  log("数据目录：" + dir);
  log("正在启动浏览器…");
  try {
    const r = await window.api.startBrowser();
    $("browserDot").className = "dot ok";
    $("browserText").textContent = `浏览器就绪 :${r.port}`;
    log(`浏览器${r.launched ? "已启动" : "已复用"}（调试端口 ${r.port}）`);
  } catch (e) {
    $("browserDot").className = "dot bad";
    log("启动浏览器失败：" + e.message);
    return;
  }
  const s = await window.api.loginState().catch(() => null);
  if (s) applyLogin(s);
  if (s && s.logged_in) {
    log(`已是登录状态：${s.nick || s.user_id}`);
  } else {
    log("检测到未登录，自动打开淘宝登录页…");
    await window.api.openLogin().catch((e) => log("打开登录页失败：" + e.message));
    log("请在浏览器窗口完成登录（不代填账号密码），登录成功后状态会自动变绿");
    setFoot("等待登录…");
    startLoginWatch();
  }
  log("提示：即使不登录，也能抓搜索结果里的销量数据。");
})();
