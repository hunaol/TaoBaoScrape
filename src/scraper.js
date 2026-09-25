// 抓取逻辑：搜索页 / 详情页 / 评价抽屉
const cdp = require("./cdp");
const browser = require("./browser");

const SEARCH_URL = (kw) => `https://s.taobao.com/search?q=${encodeURIComponent(kw)}&tab=all`;
// 商品链接选择器，多处复用
const ITEM_LINK_SEL =
  "a[href*='item.taobao.com/item.htm'], a[href*='detail.tmall.com/item.htm']";
const ITEM_COUNT = `document.querySelectorAll("${ITEM_LINK_SEL}").length`;

/** 把"2万+人付款"这类文本解析成数值。淘宝只给量级，value 是区间下界。 */
function parseSalesText(text) {
  const raw = (text || "").trim();
  if (!raw) return { raw: "", value: null, unit: "个", is_lower_bound: true };
  const m = raw.match(/([\d.]+)\s*(万|w|W|千|k|K)?/);
  if (!m) return { raw, value: null, unit: "个", is_lower_bound: true };
  let v = parseFloat(m[1]);
  if (Number.isNaN(v)) return { raw, value: null, unit: "个", is_lower_bound: true };
  let unit = "个";
  if (m[2] === "万" || m[2] === "w" || m[2] === "W") {
    v *= 10000;
    unit = "万";
  } else if (m[2] === "千" || m[2] === "k" || m[2] === "K") {
    v *= 1000;
    unit = "千";
  }
  return { raw, value: v, unit, is_lower_bound: /\+/.test(raw) };
}

/** 判定销量数字的口径：淘宝在不同排序/场景下会写「人付款」「人收货」「人看过」 */
function parseSalesMetric(text) {
  const s = text || "";
  if (s.includes("付款")) return "付款人数";
  if (s.includes("收货")) return "收货人数";
  if (s.includes("看过")) return "浏览人数";
  if (s.includes("已售")) return "已售件数";
  if (s.includes("月销")) return "月销量";
  return "";
}

/** 从"2026年9月20日已购：黑色7506FX / 155/80A"里拆日期与SKU */
function parseReviewMeta(meta) {
  const s = (meta || "").trim();
  const m = s.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  const date = m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : "";
  const skuMatch = s.match(/已购[:：]\s*(.+)$/);
  const sku = skuMatch ? skuMatch[1].trim() : "";
  let color = "";
  let size = "";
  if (sku) {
    const parts = sku.split("/").map((x) => x.trim());
    color = parts[0] || "";
    size = parts[1] || "";
  }
  return { date, sku, color, size };
}

class TaobaoSession {
  constructor({ port = browser.PORT, log = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.search = { client: null, targetId: null, url: "" };
    this.detail = { client: null, targetId: null, url: "" };
  }

  isSearchUrl = (t) => t.url.includes("s.taobao.com/search") || t.url.includes("taobao.com/search");
  isDetailUrl = (t) => /item\.taobao\.com\/item\.htm|detail\.tmall\.com\/item\.htm/.test(t.url);

  async _ensureTab(slot, matchFn, openUrl) {
    const targets = await browser.pageTargets({ port: this.port });
    let t = targets.find(matchFn);
    if (!t) {
      this.log(`新建标签页: ${openUrl}`);
      t = await browser.openTab(openUrl, { port: this.port });
      await cdp.sleep(1800);
    }
    if (slot.targetId !== t.id || !slot.client) {
      if (slot.client) slot.client.close();
      slot.client = await cdp.attach(t.webSocketDebuggerUrl);
      slot.targetId = t.id;
    }
    slot.url = t.url;
    // 关键：后台标签页 document.hidden=true，天猫/淘宝详情页会延迟渲染（docH 只有 1500 而不是 47000），
    // 评论区、价格、销量全都不生成。必须先把这个标签页提到前台。
    await slot.client.send("Page.bringToFront").catch(() => {});
    return slot.client;
  }

  async _refreshSlot(slot, matchFn) {
    const targets = await browser.pageTargets({ port: this.port });
    const t = targets.find(matchFn);
    if (!t) return null;
    if (slot.targetId !== t.id) {
      if (slot.client) slot.client.close();
      slot.client = await cdp.attach(t.webSocketDebuggerUrl);
      slot.targetId = t.id;
    }
    slot.url = t.url;
    await slot.client.send("Page.bringToFront").catch(() => {});
    return slot.client;
  }

  /**
   * 按文本找元素并返回其中心坐标。
   * 关键1：淘宝这些前端组件对 JS 的 element.click() 常常不响应，必须用 CDP 派发真实鼠标事件。
   * 关键2：目标常常在视口外（详情页很长），必须先 scrollIntoView，
   *        否则算出来的坐标点不到任何东西——这是"评价抽屉打不开"的真正原因。
   * 关键3：同一个文本会命中多层嵌套（外层 wrapper + 内层 span），
   *        所以返回**全部候选**逐个试，比赌第一个命中稳。
   */
  async _textRects(c, { exact, contains, maxLen = 16, limit = 8 }) {
    const raw = await cdp.evaluate(
      c,
      `(function(){
        var EXACT = ${JSON.stringify(exact || null)};
        var CONTAINS = ${JSON.stringify(contains || null)};
        var MAXLEN = ${Number(maxLen)};
        var LIMIT = ${Number(limit)};
        var els = document.querySelectorAll('a, div, span, li, button, em, i');
        var out = [];
        for (var i=0;i<els.length && out.length<LIMIT;i++){
          var el = els[i];
          var t = (el.innerText || '').trim();
          if (!t || t.length > MAXLEN) continue;
          var hit = EXACT ? (t === EXACT) : (t.indexOf(CONTAINS) >= 0);
          if (!hit) continue;
          out.push({
            idx: i,
            text: t,
            leaf: el.children.length === 0,
            cls: (el.className||'').toString().slice(0,50)
          });
        }
        return JSON.stringify(out);
      })()`
    );
    return JSON.parse(raw || "[]");
  }

  /** 把第 idx 个候选滚到视口中央并返回它的坐标（滚完再量，避免拿到旧坐标） */
  async _rectOfIndex(c, idx) {
    const raw = await cdp.evaluate(
      c,
      `(function(){
        var els = document.querySelectorAll('a, div, span, li, button, em, i');
        var el = els[${Number(idx)}];
        if (!el) return 'null';
        el.scrollIntoView({ block: 'center', inline: 'center' });
        var r = el.getBoundingClientRect();
        return JSON.stringify({
          x: Math.round(r.x + r.width/2),
          y: Math.round(r.y + r.height/2),
          text: (el.innerText||'').trim(),
          cls: (el.className||'').toString().slice(0,50),
          inView: r.top >= -2 && r.bottom <= (window.innerHeight + 2) && r.width > 2 && r.height > 2
        });
      })()`
    );
    return JSON.parse(raw || "null");
  }

  async _findTextRect(c, opts) {
    const cands = await this._textRects(c, Object.assign({ limit: 1 }, opts));
    if (!cands.length) return null;
    if (opts && opts.scrollIntoView) {
      await this._rectOfIndex(c, cands[0].idx).catch(() => {});
      await cdp.sleep(900);
    }
    return this._rectOfIndex(c, cands[0].idx);
  }

  /** 派发真实鼠标点击 */
  async _realClick(c, rect) {
    for (const type of ["mousePressed", "mouseReleased"]) {
      await c.send("Input.dispatchMouseEvent", {
        type,
        x: rect.x,
        y: rect.y,
        button: "left",
        clickCount: 1,
      });
    }
  }

  /** 等搜索结果列表出现（超时返回 null，不抛错，调用方必须看返回值） */
  async _waitResults(c, timeoutMs = 25000) {
    return cdp.waitFor(c, `${ITEM_COUNT} > 5`, { timeoutMs, intervalMs: 700 });
  }

  /** 当前搜索结果列表是否真的在（用于避免把「tab 激活了但列表空」误判成成功） */
  async _listReady(c) {
    const n = await cdp.evaluate(c, ITEM_COUNT).catch(() => 0);
    return Number(n) > 5;
  }

  /**
   * 页面是否被淘宝风控拦截。
   * 这类页面的 URL 通常是**正常**的（s.taobao.com/search 或 detail.tmall.com/item.htm），
   * 所以不能只看 URL，必须看内容：验证码页只有一段提示文字，结果页只有导航壳和品牌筛选条。
   */
  async _isPunished(c) {
    const js = `(function(){
      var u = location.href;
      var txt = (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
      var links = document.querySelectorAll("${ITEM_LINK_SEL}").length;
      var hasCard = !!document.querySelector('[class*="Card"]');
      var captcha = /拖放到指定区域|拖动滑块|请完成验证|点击进行验证|点我反馈|验证一下|访问受限|哎呀|网络信号走丢|请稍后再试|亲，请稍后再试/.test(txt);
      var emptySearch = /s\\.taobao\\.com\\/search/.test(u) && links === 0 && !hasCard;
      var emptyDetail = /item\\.htm/.test(u) && links === 0 && txt.length < 400 &&
        !document.querySelector("[class*='mainTitle'], [class*='MainTitle'], [class*='priceText'], [class*='price--']");
      return JSON.stringify({ captcha: captcha, emptySearch: emptySearch, emptyDetail: emptyDetail, u: u.slice(0,80) });
    })()`;
    const r = JSON.parse((await cdp.evaluate(c, js).catch(() => "{}")) || "{}");
    if (r.captcha) return "验证码";
    if (r.emptySearch) return "搜索空列表";
    if (r.emptyDetail) return "详情页空壳";
    return "";
  }

  /** 把风控状态转成可操作的中文提示 */
  _punishError(kind) {
    if (kind === "验证码") return "淘宝弹出人机验证，请在浏览器窗口完成验证后重试";
    if (kind === "详情页空壳") return "商品详情页未正常渲染（疑似风控），请在浏览器窗口看看是否需要验证，稍后重试";
    if (kind === "搜索空列表") return "淘宝返回了空搜索结果（疑似风控/限流），请稍等一会儿或完成浏览器里的验证后重试";
    return "";
  }

  async ensureSearchTab() {
    return this._ensureTab(this.search, this.isSearchUrl, SEARCH_URL("淘宝"));
  }

  async ensureDetailTab() {
    return this._ensureTab(this.detail, this.isDetailUrl, "https://www.taobao.com");
  }

  /**
   * 关键词搜索。注意：不能带 sort 参数直接导航——那样结果不渲染，必须点排序按钮。
   * 淘宝偶尔会先返回一次验证码/空列表再恢复（限流抖动），所以这里重试几次，
   * 只有连续失败才把可读的原因抛出去，避免把一次抖动当成彻底失败。
   */
  async searchByKeyword(keyword, { attempts = 3 } = {}) {
    const c = await this.ensureSearchTab();
    this.log(`搜索: ${keyword}`);
    let lastErr = "";
    for (let i = 1; i <= attempts; i++) {
      if (i > 1) {
        this.log(`第 ${i} 次重试搜索…`);
        await cdp.sleep(4000);
      }
      await c.send("Page.navigate", { url: SEARCH_URL(keyword) });
      await cdp.waitForLoad(c, { timeoutMs: 25000 });
      const ok = await this._waitResults(c, 20000);
      await cdp.sleep(1200);
      if (ok !== null || (await this._listReady(c))) return this.fetchResults();

      const kind = await this._isPunished(c);
      lastErr = kind ? this._punishError(kind) : "淘宝没有返回搜索结果";
    }
    throw new Error(lastErr);
  }

  /**
   * 按销量排序。实测结论（与网上流传的说法不同，以实测为准）：
   * - 直接导航到 &sort=sale-desc：页面壳在，但商品列表永远不渲染（count=0）→ 不能用
   * - JS element.click()：不生效（原项目栽在这）
   * - CDP 真实鼠标点击：生效。但**URL 不会变**（淘宝用 SPA 内部状态，不加 query 参数），
   *   所以不能靠 URL 判断成功，要看排序 tab 是否拿到 active 类。
   * - 但 tab 激活 ≠ 成功：风控/空响应时 tab 会激活而列表不返回，所以还要校验列表真的在。
   * - 副作用：排序后的销量口径从「N人付款」变成「N人收货」（确认收货人数），
   *   这是淘宝的「销量」定义，数字通常比付款人数小，属于正常现象。
   */
  async sortBySales({ attempts = 3 } = {}) {
    const c = await this.ensureSearchTab();
    const activeTab = `(function(){
      var els = document.querySelectorAll('[class*="customTabItem"], [class*="customTab"]');
      for (var i=0;i<els.length;i++){
        var t = (els[i].innerText||'').trim();
        if (!t || t.length > 4) continue;
        if (String(els[i].className).indexOf('active') >= 0) return t;
      }
      return '';
    })()`;

    let last = null;
    let activatedNoList = false;
    for (let i = 1; i <= attempts; i++) {
      const before = await cdp.evaluate(c, activeTab).catch(() => "");
      if (before === "销量") {
        // 已激活：只有在列表确实存在时才算成功，否则是「激活了但结果是空的」
        if (await this._listReady(c)) {
          return { ok: true, already_sorted: true, active_tab: before, attempts: i };
        }
        activatedNoList = true;
      }

      const cands = await this._textRects(c, { exact: "销量", maxLen: 4, limit: 8 });
      const leafFirst = cands.slice().sort((a, b) => Number(b.leaf) - Number(a.leaf));
      if (!leafFirst.length) return { ok: false, reason: '页面上找不到"销量"排序按钮', already_active: before === "销量" };

      this.log(`点击"销量"排序（第 ${i} 次）`);
      let clicked = false;
      for (const cand of leafFirst.slice(0, 4)) {
        const rect = await this._rectOfIndex(c, cand.idx);
        if (!rect || !rect.inView) continue;
        await this._realClick(c, rect);
        clicked = true;
        await cdp.sleep(2500);
        const after = await cdp.evaluate(c, activeTab).catch(() => "");
        last = { active_before: before, active_after: after, cls: rect.cls };
        if (after === "销量") {
          // 关键：tab 激活 ≠ 成功。淘宝风控/空响应时 tab 会激活但列表不返回，
          // 若在这里直接返回成功，上层就会拿到 0 条却以为排序好了。
          // 注意：每个候选只等一次——tab 已激活时换别的候选没有意义，直接交给外层重试，
          // 否则 4 个候选 × 25s × 3 次会把一次失败拖成好几分钟。
          const ok = await this._waitResults(c, 20000);
          if (ok !== null || (await this._listReady(c))) {
            await cdp.sleep(1200);
            return { ok: true, active_tab: after, url: await cdp.evaluate(c, "location.href").catch(() => ""), attempts: i, clicked_cls: rect.cls, note: "排序后销量口径为「人收货」" };
          }
          activatedNoList = true;
          this.log(`"销量"已激活但列表未返回（第 ${i} 次）`);
          break;
        }
      }
      if (!clicked) this.log(`第 ${i} 次未找到可点击的"销量"按钮`);
      else if (!activatedNoList) this.log(`第 ${i} 次点击后 tab 未激活，重试`);
      await cdp.sleep(1500);
    }
    if (activatedNoList) {
      const kind = await this._isPunished(c);
      return {
        ok: false,
        reason: kind ? this._punishError(kind) : '"销量"tab 已激活但商品列表未返回，请稍后重试',
        detail: last,
      };
    }
    return { ok: false, reason: '点击后"销量"tab 未变为激活状态', detail: last };
  }

  /** 抓搜索结果列表 */
  async fetchResults(maxItems = 60) {
    const c = await this.ensureSearchTab();
    const js = `(function(){
      var LIMIT = ${Number(maxItems) || 60};
      var links = document.querySelectorAll("${ITEM_LINK_SEL}");
      var seen = {}, items = [];
      function txt(root, sels){ for (var i=0;i<sels.length;i++){ var e = root.querySelector(sels[i]); if (e && (e.innerText||'').trim()) return e.innerText.trim(); } return ''; }
      for (var i=0;i<links.length && items.length<LIMIT;i++){
        var link = links[i];
        var href = link.href || '';
        if (!href || seen[href]) continue;
        seen[href] = true;
        var card = link.closest('[class*="Card"]') || (link.parentElement && link.parentElement.parentElement);
        if (!card) continue;
        var title = (link.innerText||'').trim().split('\\n')[0];
        if (!title || title.length < 3) continue;
        var price = '';
        var pi = card.querySelector("[class*='priceInt--'], [class*='priceInt']");
        var pf = card.querySelector("[class*='priceFloat--'], [class*='priceFloat']");
        if (pi) { price = (pi.innerText||'').trim(); if (pf) price += (pf.innerText||'').trim(); }
        if (!price) price = txt(card, ["[class*='price--']", "[class*='Price--']"]);
        var sales = txt(card, ["[class*='realSales--']", "[class*='realSale']", "[class*='saleNum']", "[class*='SoldCount']"]);
        var shop = txt(card, ["[class*='shopName--']", "[class*='ShopName--']", "[class*='shopName']"]);
        var imgEl = card.querySelector('img');
        var locs = card.querySelectorAll("[class*='procity']");
        var locParts = [];
        for (var j=0;j<locs.length;j++){ var v=(locs[j].innerText||'').trim(); if (v) locParts.push(v); }
        var itemId = '';
        var m = href.match(/[?&]id=(\\d+)/);
        if (m) itemId = m[1];
        var salesP = null;
        items.push({
          rank: items.length + 1,
          item_id: itemId,
          title: title.slice(0, 120),
          price: price,
          sales_text: sales,
          shop: shop.split('\\n')[0],
          location: locParts.join(' '),
          link: href.split('&mi_id=')[0].split('&spm=')[0],
          image: imgEl ? imgEl.src : ''
        });
      }
      return JSON.stringify({ url: location.href, keyword: decodeURIComponent((new URL(location.href)).searchParams.get('q')||''), count: items.length, items: items });
    })()`;
    const data = JSON.parse(await cdp.evaluate(c, js));
    if (!data.items.length) {
      // 别把风控返回的空页面当成「搜到了 0 条」，否则上层会静默显示空表格
      const kind = await this._isPunished(c);
      if (kind) throw new Error(this._punishError(kind));
    }
    data.items = data.items.map((it) => {
      const p = parseSalesText(it.sales_text);
      return {
        ...it,
        sales_value: p.value,
        sales_unit: p.unit,
        sales_is_lower_bound: p.is_lower_bound,
        sales_metric: parseSalesMetric(it.sales_text),
      };
    });
    return data;
  }

  /** 打开商品详情页 */
  async openItem(url) {
    const c = await this.ensureDetailTab();
    this.log(`打开商品: ${url.slice(0, 60)}`);
    await c.send("Page.navigate", { url });
    await cdp.waitForLoad(c, { timeoutMs: 30000 });
    // 天猫/淘宝详情页没有 h1，等价格或标题容器出现即可
    await cdp
      .waitFor(
        c,
        `!!document.querySelector("[class*='mainTitle'], [class*='MainTitle'], [class*='priceText'], [class*='price--'], [class*='ItemTitle']")`,
        { timeoutMs: 25000 }
      )
      .catch(() => {});
    // 价格/销量是懒加载的，多等一会儿
    await cdp.sleep(5000);

    const slot = await this._refreshSlot(this.detail, this.isDetailUrl);
    if (!slot) {
      // 未登录（或触发风控）时，淘宝会把详情页重定向走，导致标签不再是商品页。
      // 此时必须给出可操作的提示，而不是含糊的"标签页不在"。
      const after = await browser.pageTargets({ port: this.port });
      const cur = (after.find((t) => t.id === this.detail.targetId) || {}).url || "";
      if (/login\.taobao\.com/.test(cur)) {
        throw new Error("详情页被跳转到登录页，请点『打开登录页』登录后重试（也可能触发了风控，稍后再试）");
      }
      if (/_____tmd_____|punish|bixi\.alicdn/.test(cur)) {
        throw new Error("该商品页触发了淘宝风控验证，请在浏览器窗口完成验证后重试");
      }
      throw new Error(`详情页标签页不在（当前页面：${cur.slice(0, 60) || "未知"}）`);
    }
    // URL 是正常的 detail 页，但内容可能只是验证码/空壳——必须按内容再判一次
    const kind = await this._isPunished(slot);
    if (kind) throw new Error(this._punishError(kind));
    return slot;
  }

  /** 抓详情页基本信息 */
  async fetchDetail() {
    const c = await this._refreshSlot(this.detail, this.isDetailUrl);
    if (!c) throw new Error("详情页标签页不在");
    const js = `(function(){
      function pick(sels){ for (var i=0;i<sels.length;i++){ var e=document.querySelector(sels[i]); if (e && (e.innerText||'').trim()) return e.innerText.trim(); } return ''; }
      var title = '';
      // 详情页没有 h1，"用户评价·800+" 这类 tab 标签会污染 ItemTitle，必须优先 mainTitle
      title = pick(["[class*='mainTitle']", "[class*='MainTitle']"]);
      if (!title) {
        var h1 = document.querySelector('h1');
        if (h1) title = (h1.innerText||'').trim();
      }
      if (!title) title = pick(["[class*='itemTitle']", "[class*='ItemTitle']"]);
      // 兜底：过滤掉以"用户评价/累计评价"开头、或含"条评价"的伪标题
      if (/评价/.test(title) && title.length < 16) title = '';
      // 销量：先精确匹配"已售/人付款/人收货"这类文本
      var sales = '';
      var salesPats = [/^已售\\s*[\\d.]+\\s*[万千]?\\+?$/, /^[\\d.]+\\s*[万千]?\\+?人(付款|收货|已买)/, /^月销\\s*[\\d.]+/];
      var all = document.querySelectorAll('div,span,em,i,p');
      for (var i=0;i<all.length && !sales;i++){
        var t=(all[i].innerText||'').trim();
        if (!t || t.length>24 || all[i].children.length>1) continue;
        for (var k=0;k<salesPats.length;k++){ if (salesPats[k].test(t)) { sales=t; break; } }
      }
      if (!sales) sales = pick(["[class*='saleNum']", "[class*='SoldCount']", "[class*='realSales--']", "[class*='sellCount']", "[class*='soldQuantity']"]);
      var shop = pick(["[class*='shopName']", "[class*='ShopName']", "[class*='shop-name']", "[class*='storeName']", "[class*='StoreName']", "[class*='ShopHeader'] [class*='name']", "[class*='shopInfo'] [class*='name']"]);
      if (!shop) {
        var shopA = document.querySelector("a[href*='shop.taobao.com'], a[href*='shop.tmall.com'], a[href*='tmall.com/shop'], a[href*='/shop/view_shop'], a[href*='shopId=']");
        if (shopA) shop = (shopA.innerText||'').trim().split('\\n')[0];
      }
      // 店铺卡片常把评分/好评率/发货速度一起返回，只保留首行店名
      shop = (shop || '').split('\\n')[0].trim();
      var sub = pick(["[class*='itemSubtitle']", "[class*='subtitle']", "[class*='SubTitle']"]);
      var price = pick(["[class*='priceText']", "[class*='priceValue']", "[class*='Price--'] [class*='text']"]);
      if (!price) price = pick(["[class*='price--']", "[class*='Price--']"]);
      if (!price) {
        // 新版(pc-detail-ssr-2025)价格没有稳定类名，从购买区文本里抠
        var pn = document.querySelector("[class*='PurchasePanel'], [class*='purchasePanel'], [class*='detailWrap']");
        var ptext = pn ? (pn.innerText || '') : (document.body.innerText || '');
        var pm = ptext.match(/[￥¥]\\s*([\\d,]+(?:\\.\\d+)?)/);
        if (pm) price = pm[1].replace(/,/g, '');
      }
      if (!price) {
        var pm2 = (document.body.innerText || '').match(/[￥¥]\\s*([\\d,]+(?:\\.\\d+)?)/);
        if (pm2) price = pm2[1].replace(/,/g, '');
      }
      var imgs = [];
      var els = document.querySelectorAll("[class*='mainPic'] img, [class*='thumbnail'] img, [class*='Pic--'] img, ul[class*='thumb'] img");
      for (var j=0;j<els.length && imgs.length<12;j++){
        var s = els[j].src || els[j].getAttribute('data-src') || '';
        if (s && imgs.indexOf(s)<0) imgs.push(s.startsWith('//') ? 'https:'+s : s);
      }
      var sku = [];
      var skuEls = document.querySelectorAll("[class*='skuItem'], [class*='SkuItem'], [class*='valueItem']");
      for (var q=0;q<skuEls.length && sku.length<40;q++){ var v=(skuEls[q].innerText||'').trim(); if (v && sku.indexOf(v)<0) sku.push(v); }
      var itemId = '';
      var m = location.href.match(/[?&]id=(\\d+)/);
      if (m) itemId = m[1];
      // 页面形态判定：新版 SSR 详情页只有购买面板，不含详情/评价模块
      var hasReviewModule = !!document.querySelector("[class*='Comment--'], [class*='Rate--'], [class*='rateItem'], [class*='tm-rate'], [class*='Drawer--']");
      var hasDescModule = !!document.querySelector("[class*='detailContent'], [class*='descContent'], [class*='ItemDetail'], [class*='description']");
      var punished = Array.prototype.some.call(document.querySelectorAll('iframe'), function(f){ return /punish|captcha/i.test(String(f.src||'')); });
      var kind = punished ? 'punish' : (hasReviewModule ? 'full' : 'purchase-panel-only');
      return JSON.stringify({ url: location.href, item_id: itemId, title: title, subtitle: sub, price: price, sales_text: sales, shop: shop, main_images: imgs, sku_options: sku, page_kind: kind, has_review_module: hasReviewModule, has_desc_module: hasDescModule, punished: punished });
    })()`;
    const data = JSON.parse(await cdp.evaluate(c, js));
    const p = parseSalesText(data.sales_text);
    data.sales_value = p.value;
    data.sales_is_lower_bound = p.is_lower_bound;
    data.is_tmall = /tmall\.com/.test(data.url);
    return data;
  }

  /**
   * 探测详情页能否抓到评价。
   * 实测(2026-09-24)：淘宝 PC 详情页已换成 `tbpc-pc-detail-ssr-2025`，
   * 只 SSR 出"购买面板"(标题/价格/SKU/按钮)，页面里既没有详情描述模块也没有评价模块，
   * 旧的 rate.tmall.com/list_detail_rate.htm 等接口已下线，移动版 H5 又会走风控(punish)。
   * 所以先判定形态，避免每次都白等几十秒。
   */
  async probeReviewAvailability() {
    const c = await this._refreshSlot(this.detail, this.isDetailUrl);
    if (!c) return { ok: false, reason: "详情页标签页不在" };
    const raw = await cdp.evaluate(
      c,
      `(function(){
        var punished = Array.prototype.some.call(document.querySelectorAll('iframe'), function(f){ return /punish|captcha/i.test(String(f.src||'')); });
        var reviewish = 0;
        var els = document.querySelectorAll('a,div,span,button,li');
        for (var i=0;i<els.length && reviewish<5;i++){
          var t = (els[i].innerText||'').trim();
          if (t.length>0 && t.length<=24 && t.indexOf('评价')>=0) reviewish++;
        }
        return JSON.stringify({
          punished: punished,
          review_module: !!document.querySelector("[class*='Comment--'], [class*='Rate--'], [class*='rateItem'], [class*='Drawer--']"),
          review_text_nodes: reviewish,
          doc_h: document.body.scrollHeight,
          url: location.href.slice(0, 110)
        });
      })()`
    );
    const d = JSON.parse(raw || "{}");
    d.ok = !!d.review_module;
    if (!d.ok) {
      d.reason = d.punished
        ? "详情页触发了淘宝风控验证，需要在浏览器窗口里手动完成验证后重试"
        : "当前详情页（新版 SSR）不含评价模块，淘宝已把评价从 PC 详情页移除";
    }
    return d;
  }

  /** 打开"查看全部评价"抽屉。真实鼠标点击 + 兜底 JS 点击。 */
  async openReviews({ timeoutMs = 25000 } = {}) {
    const c = await this._refreshSlot(this.detail, this.isDetailUrl);
    if (!c) throw new Error("详情页标签页不在");

    // 注意：详情页本身就有 1~2 条内嵌评价，所以不能只看有没有 Comment，
    // 必须等到"抽屉"出现，否则会误判成已打开。
    const hasComments = `document.querySelectorAll('[class*="Drawer--"] [class*="Comment--"]').length > 0`;
    if (await cdp.evaluate(c, hasComments)) return { ok: true, already_open: true };

    // 先判定页面有没有评价模块，避免在"新版 SSR 购买面板页"上白等
    const avail = await this.probeReviewAvailability();
    if (avail.punished) return { ok: false, reason: avail.reason, need_verify: true, page_kind: "punish" };
    if (!avail.ok && avail.review_text_nodes === 0) {
      return { ok: false, reason: avail.reason, page_kind: "purchase-panel-only" };
    }

    // 先滚动到评价区域，某些布局下按钮未渲染
    await cdp.evaluate(c, `window.scrollTo(0, document.body.scrollHeight * 0.6)`).catch(() => {});
    await cdp.sleep(1500);

    // 逐个候选试：同一文本会命中外层 wrapper 与内层 span，赌第一个不稳
    const cands = [];
    for (const txt of ["查看全部评价", "用户评价", "累计评价", "条评价"]) {
      const list = await this._textRects(c, { contains: txt, maxLen: txt.length + 8, limit: 8 });
      for (const x of list) if (!cands.some((y) => y.idx === x.idx)) cands.push(x);
    }
    // 内层（leaf）优先，点击命中率高
    cands.sort((a, b) => Number(b.leaf) - Number(a.leaf));

    let tried = 0;
    let ok = false;
    for (const cand of cands.slice(0, 6)) {
      const rect = await this._rectOfIndex(c, cand.idx);
      if (!rect || !rect.inView) continue;
      tried++;
      this.log(`点击「${rect.text}」(真实鼠标, ${rect.cls})`);
      await this._realClick(c, rect);
      ok = await cdp.waitFor(c, hasComments, { timeoutMs: 6000, intervalMs: 600 });
      if (ok) break;
    }

    // 兜底：JS 点击（含原生 MouseEvent 序列）
    if (!ok) {
      this.log("真实点击未生效，改用 JS 点击兜底");
      await cdp.evaluate(
        c,
        `(function(){
          var els = document.querySelectorAll('div,span,a,button');
          var best = null;
          for (var i=0;i<els.length;i++){
            var t=(els[i].innerText||'').trim();
            if (t.indexOf('查看全部评价')>=0 && t.length<12 && els[i].children.length===0) { best = els[i]; break; }
          }
          if (best) {
            best.scrollIntoView({ block: 'center' });
            var r = best.getBoundingClientRect();
            best.click();
            var ev = function(type){ best.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: r.x + r.width/2, clientY: r.y + r.height/2 })); };
            ev('mousedown'); ev('mouseup'); ev('click');
            return true;
          }
          return false;
        })()`
      );
      ok = await cdp.waitFor(c, hasComments, { timeoutMs: 12000, intervalMs: 600 });
    }

    if (!ok) return { ok: false, reason: "点击后评价列表未出现", tried, candidates: cands.slice(0, 6), url: await cdp.evaluate(c, "location.href").catch(() => "") };
    await cdp.sleep(2000);
    return { ok: true };
  }

  /** 抓评价抽屉里的评价与筛选标签统计 */
  async fetchReviews() {
    const c = await this._refreshSlot(this.detail, this.isDetailUrl);
    if (!c) throw new Error("详情页标签页不在");
    const js = `(function(){
      var drawer = document.querySelector('[class*="Drawer--"]');
      if (!drawer) return JSON.stringify({ error: '评价抽屉未打开（详情页内嵌评价不计入）' });
      var root = drawer;
      var all = root.querySelectorAll('[class*="Comment--"]');
      var reviews = [];
      for (var i=0;i<all.length;i++){
        var n = all[i];
        if (n.parentElement && n.parentElement.closest('[class*="Comment--"]')) continue; // 跳过嵌套
        var u = n.querySelector('[class*="userName--"]');
        var meta = n.querySelector('[class*="meta--"]');
        var ct = n.querySelector('[class*="content--"]');
        var lines = (n.innerText||'').split('\\n').map(function(s){return s.trim()}).filter(Boolean);
        var reply = '';
        for (var k=0;k<lines.length;k++){ if (lines[k].indexOf('商家回复') === 0) { reply = lines[k]; break; } }
        var userName = u ? (u.innerText||'').trim() : '';
        var tags = [];
        for (var t=0;t<lines.length;t++){
          var L = lines[t];
          if (L.length >= 2 && L.length <= 8 && !/^\\d/.test(L) && L.indexOf('已购')<0 && L.indexOf('回复')<0 && L.indexOf('商家')<0 && L !== userName) tags.push(L);
        }
        reviews.push({
          user: userName,
          meta: meta ? (meta.innerText||'').trim() : '',
          text: ct ? (ct.innerText||'').trim() : '',
          seller_reply: reply.replace(/^商家回复[:：]?\\s*/, ''),
          tag_candidates: tags.slice(0, 6)
        });
      }
      var stats = [];
      var statRoot = root.querySelector('[class*="Comments--"], [class*="tags--"], [class*="Tags--"]');
      if (statRoot) {
        var segs = (statRoot.innerText||'').split('\\n').map(function(s){return s.trim()}).filter(Boolean);
        for (var s=0;s<segs.length;s++) stats.push(segs[s]);
      }
      var totalText = '';
      var lines2 = (root.innerText||'').split('\\n');
      for (var z=0;z<lines2.length;z++){ if (lines2[z].indexOf('用户评价') >= 0) { totalText = lines2[z].trim(); break; } }
      return JSON.stringify({ total_text: totalText, stat_lines: stats, count: reviews.length, reviews: reviews });
    })()`;
    const data = JSON.parse(await cdp.evaluate(c, js));
    if (data.reviews) data.reviews = data.reviews.map((r) => ({ ...r, ...parseReviewMeta(r.meta) }));
    return data;
  }

  close() {
    for (const slot of [this.search, this.detail]) {
      if (slot.client) slot.client.close();
      slot.client = null;
      slot.targetId = null;
    }
  }
}

module.exports = { TaobaoSession, parseSalesText, parseSalesMetric, parseReviewMeta, SEARCH_URL, ITEM_LINK_SEL };
