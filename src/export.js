// 导出 CSV / JSON
const fs = require("fs");
const path = require("path");

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function csvCell(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).replace(/\r?\n/g, " ").replace(/"/g, '""');
  return /[",]/.test(s) ? `"${s}"` : s;
}

/** rows: 对象数组；columns: [{key, label}] */
function toCsv(rows, columns) {
  const head = columns.map((c) => csvCell(c.label)).join(",");
  const body = rows.map((r) => columns.map((c) => csvCell(r[c.key])).join(",")).join("\r\n");
  // BOM 让 Excel 正确识别 UTF-8
  return "\uFEFF" + head + "\r\n" + body + "\r\n";
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveAll({ dir, basename, rows, columns, meta }) {
  ensureDir(dir);
  const stamp = timestamp();
  const base = `${basename || "taobao"}-${stamp}`;
  const csvPath = path.join(dir, `${base}.csv`);
  const jsonPath = path.join(dir, `${base}.json`);
  fs.writeFileSync(csvPath, toCsv(rows, columns), "utf8");
  fs.writeFileSync(
    jsonPath,
    JSON.stringify({ exported_at: new Date().toISOString(), ...meta, count: rows.length, data: rows }, null, 2),
    "utf8"
  );
  return { csv: csvPath, json: jsonPath };
}

const SEARCH_COLUMNS = [
  { key: "rank", label: "排名" },
  { key: "item_id", label: "商品ID" },
  { key: "title", label: "标题" },
  { key: "price", label: "价格" },
  { key: "sales_text", label: "销量原文" },
  { key: "sales_value", label: "销量估算值" },
  { key: "sales_is_lower_bound", label: "销量为下限" },
  { key: "shop", label: "店铺" },
  { key: "location", label: "发货地" },
  { key: "link", label: "链接" },
];

const REVIEW_COLUMNS = [
  { key: "item_id", label: "商品ID" },
  { key: "item_title", label: "商品标题" },
  { key: "user", label: "用户" },
  { key: "date", label: "评价日期" },
  { key: "sku", label: "已购SKU" },
  { key: "color", label: "颜色" },
  { key: "size", label: "尺码" },
  { key: "text", label: "评价内容" },
  { key: "seller_reply", label: "商家回复" },
];

module.exports = { toCsv, saveAll, ensureDir, timestamp, SEARCH_COLUMNS, REVIEW_COLUMNS };
