// 命令行测试入口：不启动 Electron，直接验证抓取链路
// 用法: node cli.js <关键词> [--sort] [--reviews N] [--out DIR]
const path = require("path");
const browser = require("./src/browser");
const { TaobaoSession } = require("./src/scraper");
const ex = require("./src/export");

const args = process.argv.slice(2);
const keyword = args.find((a) => !a.startsWith("--")) || "羽绒服";
const doSort = args.includes("--sort");
const ri = args.indexOf("--reviews");
const reviewCount = ri >= 0 ? parseInt(args[ri + 1] || "3", 10) : 0;
const oi = args.indexOf("--out");
const outDir = oi >= 0 ? args[oi + 1] : path.join(__dirname, "output");

async function main() {
  const log = (m) => console.log("[*]", m);
  await browser.ensureBrowser({ log });

  const s = new TaobaoSession({ log });
  try {
    let data = await s.searchByKeyword(keyword);
    console.log(`\n=== 搜索 "${keyword}" : ${data.count} 条 ===`);
    data.items.slice(0, 8).forEach((x) =>
      console.log(`  ${String(x.sales_text).padEnd(14)} ¥${String(x.price).padEnd(9)} ${x.title.slice(0, 26)}`)
    );

    if (doSort) {
      log("按销量排序…");
      const r = await s.sortBySales();
      console.log("排序结果:", JSON.stringify(r));
      data = await s.fetchResults();
      if (r.ok) {
        console.log(`\n=== 销量排序后 Top 10（服务端排序） ===`);
      } else {
        // 服务端点不动时，至少把本页 46 条按销量降序排，给出"本页最热"
        data.items.sort((a, b) => (b.sales_value || 0) - (a.sales_value || 0));
        data.items.forEach((x, i) => (x.rank = i + 1));
        console.log(`\n=== 服务端排序未生效，改按本页销量降序 Top 10 ===`);
      }
      data.items.slice(0, 10).forEach((x) =>
        console.log(`  ${String(x.sales_text).padEnd(14)} ¥${String(x.price).padEnd(9)} ${x.title.slice(0, 26)}`)
      );
    }

    const searchSave = ex.saveAll({
      dir: outDir,
      basename: `search-${keyword}`,
      rows: data.items,
      columns: ex.SEARCH_COLUMNS,
      meta: { type: "search", keyword, url: data.url },
    });
    console.log("\n已导出:", searchSave.csv);

    if (reviewCount > 0 && data.items.length) {
      const allReviews = [];
      const targets = data.items.slice(0, reviewCount);
      for (const item of targets) {
        console.log(`\n--- 抓评价: ${item.title.slice(0, 30)} ---`);
        try {
          await s.openItem(item.link);
          const detail = await s.fetchDetail();
          console.log(`  详情: ${detail.title.slice(0, 40)} | 价格=${detail.price} | 销量=${detail.sales_text}`);
          const opened = await s.openReviews();
          if (!opened.ok) {
            console.log("  打开评价失败:", opened.reason, "| 候选:", JSON.stringify(opened.candidates || null));
            continue;
          }
          const rv = await s.fetchReviews();
          console.log(`  评价: ${rv.count} 条 | 汇总: ${rv.total_text} | 筛选标签: ${(rv.stat_lines || []).slice(0, 12).join(" / ")}`);
          (rv.reviews || []).slice(0, 3).forEach((r) =>
            console.log(`    · ${r.user} ${r.date} [${r.sku}] ${r.text.slice(0, 40)}`)
          );
          for (const r of rv.reviews || []) {
            allReviews.push({ ...r, item_id: detail.item_id, item_title: detail.title });
          }
        } catch (e) {
          console.log("  出错:", e.message);
        }
      }
      if (allReviews.length) {
        const rs = ex.saveAll({
          dir: outDir,
          basename: `reviews-${keyword}`,
          rows: allReviews,
          columns: ex.REVIEW_COLUMNS,
          meta: { type: "reviews", keyword },
        });
        console.log(`\n评价已导出: ${allReviews.length} 条 -> ${rs.csv}`);
      }
    }
  } finally {
    s.close();
  }
}

main().catch((e) => {
  console.error("失败:", e.message);
  process.exit(1);
});
