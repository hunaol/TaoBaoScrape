# TaoBaoScrape · 淘宝销量采集器

一个 Windows 桌面工具：双击打开 → 输入关键词 → 自动抓取淘宝搜索页的商品销量数据 → 导出 CSV / JSON。

不需要挖象浏览器、不需要生意参谋卖家权限、不需要自己写爬虫。原理是启动一个带调试端口的 Chrome/Edge，用 Chrome DevTools Protocol（CDP）驱动它像真人一样操作页面，再把结果结构化导出。

> ⚠️ 本项目仅供个人学习与数据分析使用。请遵守淘宝的用户协议与 robots 规则，控制请求频率，不要用于商业采集或大规模抓取。

---

## 功能

| 功能 | 状态 | 说明 |
|---|---|---|
| 关键词搜索商品列表 | ✅ 可用 | 一页 44~47 条，含标题、价格、销量、店铺、发货地、链接 |
| 按销量排序 | ✅ 可用 | 服务端排序，降序；排序后销量口径变为「人收货」 |
| 商品详情页解析 | ✅ 可用 | 标题、价格、店铺名、主图、SKU 选项 |
| 批量抓前 N 条详情 | ✅ 可用 | 逐条限速访问，边抓边落盘 |
| 导出 CSV + JSON | ✅ 可用 | CSV 带 UTF-8 BOM，Excel 直接打开不乱码 |
| **抓商品评论** | ❌ **不可用** | 见下方「已知限制」 |

### 界面

主界面包含：关键词输入、是否按销量排序、抓取条数、搜索结果表格（每行可单独点「详情」）、批量抓取、运行日志、数据目录快捷入口。

---

## 快速开始（用打包好的 exe）

1. 下载 exe：**[点此下载 dist/TaobaoInsight.exe](https://github.com/hunaol/TaoBaoScrape/raw/main/dist/TaobaoInsight.exe)**
   （仓库里直接带了打包好的产物，约 71 MB；也可以在文件页面点 Download 按钮）
2. 双击运行
   - 首次运行 Windows SmartScreen 会拦截（exe 未签名），点 **「更多信息」→「仍要运行」**
3. 程序会自动启动浏览器并检测登录态，未登录会自动打开淘宝登录页
4. 在弹出的浏览器窗口里**扫码或手动登录**（程序不会、也无法代填账号密码）
5. 回到程序窗口，输入关键词 → 点「搜索并导出」
6. 结果导出到 `C:\Users\<你的用户名>\TaobaoInsight-data\`

> 不登录也能抓搜索结果里的销量数据。登录后详情页解析才完整。

### 运行环境要求

- **64 位 Windows 10 或更高版本**（Electron 33 不支持 Win7/8，也不支持 32 位系统）
- **需要安装 Chrome 或 Edge 其中之一**（Win10/11 自带 Edge，通常已满足）
  - 都没有的话程序会提示「未找到 Chrome 或 Edge，请先安装其中之一」
- 不需要装 Node.js、Python、VC++ 运行库

程序用的是**独立浏览器配置目录** `C:\Users\<你的用户名>\.taobao-insight\browser-profile`，与你日常使用的 Chrome 互不影响，因此需要在这个窗口里单独登录一次。

---

## 从源码构建

```bash
git clone https://github.com/hunaol/TaoBaoScrape.git
cd TaoBaoScrape
npm install
```

### 开发运行

```bash
npm start          # 启动 Electron 桌面界面
npm run cli -- 羽绒服 --sort        # 命令行版，不走界面
```

命令行参数：

```bash
node cli.js <关键词> [--sort] [--reviews N] [--out DIR]
```

### 打包 exe

```bash
npm run dist       # 产物：dist/TaobaoInsight.exe（单文件 portable）
```

打包配置在 `package.json` 的 `build` 字段。其中 `"signAndEditExecutable": false` 是必要的：它跳过代码签名和 rcedit 改写资源，否则在**没有创建符号链接权限**的 Windows 上，electron-builder 会在解压 winCodeSign 时失败（`Cannot create symbolic link : 客户端没有所需的特权`）。

> 国内网络如果下载 Electron 卡住，可先设镜像：
> ```bash
> npm config set ELECTRON_MIRROR https://npmmirror.com/mirrors/electron/
> npm config set ELECTRON_BUILDER_BINARIES_MIRROR https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

---

## 测试

三层自动化测试，共 48 个用例：

```bash
npm test           # src 层（25 例）：直接驱动 CDP，测解析/导出/搜索/排序/详情
npm run test:gui   # GUI/IPC 层（18 例）：真启动 Electron，测 preload 桥 → IPC → src 全链路
npm run test:exe   # 打包产物（5 例）：跑 dist/TaobaoInsight.exe，测 asar 加载与真实抓取
```

测试会连接真实淘宝，因此**受淘宝限流影响**：

- 淘宝偶尔会返回拖图验证码或空搜索结果，几分钟后自愈
- 遇到这种情况测试会输出 **`⚠ SKIP（风控）`** 而不是 `✘ FAIL`——这是环境状态，不是代码回归
- 连续跑多轮必然触发限流，**每轮之间建议冷却 1~3 分钟**

---

## 输出数据格式

导出到 `C:\Users\<用户名>\TaobaoInsight-data\`，每次导出同时生成 `.csv` 和 `.json` 两份。

**搜索结果** `search-<关键词>-<时间戳>.csv`

| 列 | 说明 |
|---|---|
| 排名 | 当前页序号（按销量排序后即为销量排名） |
| 商品ID | 从链接提取的数字 ID |
| 标题 | 商品标题 |
| 价格 | 展示价，可能是区间 |
| 销量原文 | 页面上原样的文本，如 `1000+人收货` |
| 销量估算值 | 解析后的数值，`1000+` → `1000` |
| 销量为下限 | `true` 表示原文带 `+`，实际值可能更高 |
| 店铺 / 发货地 / 链接 | 原始信息 |

**JSON 额外含**：`exported_at`、`keyword`、`url`、`sales_sorted`、`count`。

⚠️ 销量是**区间文本**（淘宝只给量级），`1000+` 不代表真实销量是 1000，只能做量级参考，不能用于严谨统计。

---

## 已知限制

### 抓评论已不可行

这不是没实现，而是**淘宝已经把这条路封死了**，具体依据：

1. 淘宝 PC 详情页已换成新版 SSR 组件（`@ali/tbpc-pc-detail-ssr-2025`），服务端只渲染购买面板，**整个页面不含评价模块**——实测文档高度恒为 1486px，页面上没有 `Comment--` / `Drawer--` / `description` 任何一个节点，评价 tab 容器是个空 div。
2. 旧版评价接口 `rate.tmall.com/list_detail_rate.htm`、`rate.taobao.com/detailRateList.htm` 均已废弃。
3. H5 详情页被 `bixi.alicdn.com/punish/...` 风控拦截。
4. 页面根本不请求 `mtop.taobao.pcdetail.data.get`，手工构造该 mtop 请求会 timeout。

所以程序里的「抓评价」会**快速失败并给出可读原因**（约 5~15 秒返回），而不是空等 25 秒超时。批量抓取时评价部分会记为 `0` 并继续，不影响销量数据的抓取。

需要评论数据的话，替代方案：找第三方数据服务（禅妈妈、飞瓜等有公开榜单）、或改抓详情页仍可见的**评分 / 评价数**这类聚合指标、或重新设计研究问题。

### 其他

- **销量口径会变**：按销量排序后，数字含义从「N人付款」变成「N人收货」（确认收货人数），通常比付款人数小，属正常现象。
- **只有第一页**：默认抓当前页 44~47 条，不含翻页。
- **详情页有限速**：两次详情页访问间隔 15 秒（`DETAIL_COOLDOWN_MS`），降低风控概率，代价是批量抓取较慢。
- **风控**：触发验证码时程序会提示「请在浏览器窗口完成验证后重试」，手动过验证即可恢复。

---

## 常见问题

**双击没反应 / 被杀毒软件拦截**
portable exe 是自解压格式，运行时往临时目录释放文件，360、火绒等国产杀软容易误报。加白名单即可。这是未签名的必然结果。

**提示「未找到 Chrome 或 Edge」**
装一个 Chrome，或确认 Edge 没有被卸载。

**提示「详情页被跳转到登录页」**
登录态失效了，点界面上的「打开登录页」重新登录。

**提示「淘宝弹出人机验证」**
在浏览器窗口里手动完成滑块/拖图验证，然后重试。

**抓到的销量都是「1000+」这种**
淘宝只给量级，这是数据源本身的限制，不是程序问题。

---

## 项目结构

```
TaoBaoScrape/
├── main.js              # Electron 主进程：窗口、IPC、任务编排、限速
├── preload.js           # contextBridge 安全桥（contextIsolation 开启）
├── cli.js               # 命令行入口，不启动 Electron
├── ui/                  # 渲染进程界面（原生 HTML/CSS/JS，无框架）
│   ├── index.html
│   ├── renderer.js
│   └── style.css
├── src/
│   ├── browser.js       # 查找/启动 Chrome，标签页管理
│   ├── cdp.js           # CDP over WebSocket 的薄封装（evaluate/send/waitFor）
│   ├── session.js       # 登录态检测、登录页打开、等待登录
│   ├── scraper.js       # 核心抓取：搜索、销量排序、详情页、评价探测
│   └── export.js        # CSV/JSON 导出（UTF-8 BOM）
└── test/
    ├── e2e-src.js       # src 层端到端
    ├── e2e-gui.js       # GUI/IPC 层端到端
    └── smoke-exe.js     # 打包产物冒烟
```

## 实现要点

几个踩过的坑，记录在此避免重复踩：

- **`document.cookie` 是按源隔离的**。读登录态必须用 CDP 的 `Network.getCookies` 并按 taobao.com 的 URL 显式取；否则当脚本落在 `detail.tmall.com` 标签上时读不到 `.taobao.com` 的 `unb`，会把已登录误判成未登录。
- **淘宝的 React 组件不响应 JS 的 `element.click()`**，必须用 CDP `Input.dispatchMouseEvent` 派发真实鼠标事件。
- **`getBoundingClientRect()` 是视口相对坐标**，点击前必须先 `scrollIntoView({block:'center'})`，否则点在空处。
- **后台标签页会延迟渲染**（`document.hidden=true`），必须 `Page.bringToFront`，否则详情页价格/销量全都不生成。
- **销量排序不会改变 URL**，成功信号是排序 tab 上的 `active` 类，不能靠 URL 判断。
- **tab 激活 ≠ 排序成功**：风控时 tab 会激活但列表不返回，必须再校验列表真的存在。
- **淘宝的 class 名是 CSS Module 哈希**（如 `Comment--H5QmJwe9`），只有前缀稳定，选择器必须用 `[class*=]` 匹配。

## License

UNLICENSED — 仅个人使用。
