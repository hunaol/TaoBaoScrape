// 渲染进程与主进程之间的安全桥
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  startBrowser: () => ipcRenderer.invoke("browser:start"),
  openLogin: () => ipcRenderer.invoke("login:open"),
  loginState: () => ipcRenderer.invoke("login:state"),
  waitLogin: () => ipcRenderer.invoke("login:wait"),

  runSearch: (payload) => ipcRenderer.invoke("search:run", payload),
  fetchDetail: (payload) => ipcRenderer.invoke("detail:fetch", payload),
  probeReviews: () => ipcRenderer.invoke("reviews:probe"),
  fetchReviews: (payload) => ipcRenderer.invoke("reviews:fetch", payload),
  runBatch: (payload) => ipcRenderer.invoke("batch:run", payload),

  outputDir: () => ipcRenderer.invoke("env:outputDir"),
  openOutput: () => ipcRenderer.invoke("env:openOutput"),
  profileDir: () => ipcRenderer.invoke("env:profileDir"),
  openUrl: (url) => ipcRenderer.invoke("shell:open", url),
  reveal: (p) => ipcRenderer.invoke("shell:reveal", p),

  onLog: (fn) => ipcRenderer.on("log", (_e, msg) => fn(msg)),
  onProgress: (fn) => ipcRenderer.on("progress", (_e, p) => fn(p)),
});
