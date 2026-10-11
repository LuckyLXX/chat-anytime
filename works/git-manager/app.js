/**
 * Git 管理器 —— 面板逻辑。
 *
 * 数据全部来自本地 Git Bridge（bridge.mjs，由平台在开窗前拉起）：
 *   API_BASE 同源（页面由 bridge 自己 serve 时）或 http://127.0.0.1:8791（面板页，
 *   靠平台给面板窗口放宽的 CORS）。
 *
 * 纪律：
 * - 一切用户/仓库来源的文本都用 textContent 写入（提交信息、文件名、diff 内容都算不可信输入）。
 * - 不引第三方库、不联网比对任何东西；失败一律落到页内的状态块，不白屏。
 * - 只读：这个页面只会发 GET，不会修改仓库（bridge 侧也只实现查询命令）。
 */

import { layoutGraph } from "./graph.js";

const BRIDGE_PORT = 8791;
/**
 * 面板页（pidesktop-file://）连本地桥；由桥自己 serve 时同源直连（开发 / 降级通道）。
 * 判据必须是「确实是桥在服务」：内置浏览器预览本地文件时也会把它映射成 http（随机端口），
 * 那种情况仍然要连 8791。
 */
const API_BASE =
  location.protocol === "http:" && location.port === String(BRIDGE_PORT) ? "" : `http://127.0.0.1:${BRIDGE_PORT}`;
const PAGE_SIZE = 60;
const PREFS_KEY = "git-manager.prefs.v1";
const LANE_W = 16;
const LANE_X0 = 10;
const ROW_H = 44;

/** 真机排查用：任何未捕获的错误都留在这里（browser_eval 读 window.__git_manager_errors）。 */
const errors = [];
window.__git_manager_errors = errors;
window.addEventListener("error", (event) => errors.push(String(event.message)));
window.addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));

const dom = {
  repoButton: document.getElementById("repoButton"),
  repoName: document.getElementById("repoName"),
  repoBranch: document.getElementById("repoBranch"),
  repoPicker: document.querySelector(".repo-picker"),
  repoMenu: document.getElementById("repoMenu"),
  repoMenuList: document.getElementById("repoMenuList"),
  repoPathInput: document.getElementById("repoPathInput"),
  repoPathAdd: document.getElementById("repoPathAdd"),
  searchInput: document.getElementById("searchInput"),
  themeBtn: document.getElementById("themeBtn"),
  refreshBtn: document.getElementById("refreshBtn"),
  bridgeStatus: document.getElementById("bridgeStatus"),
  branchList: document.getElementById("branchList"),
  branchCount: document.getElementById("branchCount"),
  tagList: document.getElementById("tagList"),
  tagCount: document.getElementById("tagCount"),
  repoMeta: document.getElementById("repoMeta"),
  clearRefBtn: document.getElementById("clearRefBtn"),
  listTitle: document.getElementById("listTitle"),
  listSub: document.getElementById("listSub"),
  listScroll: document.getElementById("listScroll"),
  listRows: document.getElementById("listRows"),
  listSentinel: document.getElementById("listSentinel"),
  allBranches: document.getElementById("allBranches"),
  allBranchesToggle: document.getElementById("allBranchesToggle"),
  detailPane: document.getElementById("detailPane"),
  toast: document.getElementById("toast")
};

// —— 小工具 ——

function el(tag, className, children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (children !== undefined) {
    for (const child of Array.isArray(children) ? children : [children]) {
      if (child === undefined || child === null || child === false) continue;
      node.append(typeof child === "string" || typeof child === "number" ? document.createTextNode(String(child)) : child);
    }
  }
  return node;
}

function icon(path, extraClass) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  if (extraClass) svg.setAttribute("class", extraClass);
  const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
  node.setAttribute("d", path);
  svg.append(node);
  return svg;
}

const ICONS = {
  branch: "M6 3v12M6 9h6a3 3 0 0 0 3-3V4M6 4v0",
  tag: "M20.6 12.3 12.3 20.6a2 2 0 0 1-2.8 0l-6.1-6.1a2 2 0 0 1-.6-1.4V4.5A1.5 1.5 0 0 1 4.3 3h8.6a2 2 0 0 1 1.4.6l6.3 6.3a2 2 0 0 1 0 2.4zM7.5 7.5h.01",
  clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5V12l3 2",
  file: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5",
  plug: "M9 3v6M15 3v6M7 9h10v3a5 5 0 0 1-5 5v4"
};

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function relTime(epochSeconds) {
  if (!epochSeconds) return "";
  const diff = Date.now() / 1000 - epochSeconds;
  if (diff < 60) return "刚刚";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))} 个月前`;
  return `${(diff / (86400 * 365)).toFixed(1)} 年前`;
}

const STATUS_LABEL = { A: "增", M: "改", D: "删", R: "名", C: "拷", T: "型", U: "冲" };
const WORKTREE_STATUS = { M: "改", A: "增", D: "删", R: "名", "?": "新", "!": "忽", T: "型", U: "冲" };

/** 文本里高亮查询串（返回 DocumentFragment；不做 HTML 拼接，避免注入）。 */
function highlighted(text, query) {
  const fragment = document.createDocumentFragment();
  if (!query) {
    fragment.append(document.createTextNode(text));
    return fragment;
  }
  const lower = text.toLowerCase();
  const needle = query.toLowerCase();
  let index = 0;
  while (index < text.length) {
    const found = lower.indexOf(needle, index);
    if (found < 0) {
      fragment.append(document.createTextNode(text.slice(index)));
      break;
    }
    if (found > index) fragment.append(document.createTextNode(text.slice(index, found)));
    const mark = el("span", "highlight", text.slice(found, found + needle.length));
    fragment.append(mark);
    index = found + needle.length;
  }
  return fragment;
}

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => toast("已复制")).catch(() => toast("复制失败，请手动选择文本"));
    return;
  }
  toast(text);
}

let toastTimer;
function toast(message, isError = false) {
  dom.toast.textContent = message;
  dom.toast.hidden = false;
  dom.toast.classList.toggle("is-error", isError);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.hidden = true; }, isError ? 6000 : 2200);
}

// —— API ——

async function api(path, params) {
  // 以当前地址为 base：API_BASE 为空（页面由桥同源 serve）时是相对路径，非空时是绝对地址。
  const url = new URL(`${API_BASE}${path}`, location.href);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url.toString(), { cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`桥返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (!payload || payload.ok !== true) throw new Error(payload?.error ?? "请求失败");
  return payload;
}

/** 连通性 + 端点可用性（也给「桥没起来」的引导页用）。 */
async function probeBridge() {
  try {
    const response = await fetch(`${API_BASE}/api/health`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await response.json();
    setBridge("ok", "已连接");
    return true;
  } catch (error) {
    setBridge("bad", API_BASE ? "未连接" : "异常");
    return false;
  }
}

function setBridge(state, text) {
  dom.bridgeStatus.className = `bridge ${state === "ok" ? "is-ok" : state === "bad" ? "is-bad" : ""}`;
  dom.bridgeStatus.querySelector(".bridge-text").textContent = text;
}

// —— 偏好（面板 origin 固定，localStorage 跨启动稳定） ——

const prefs = loadPrefs();

function loadPrefs() {
  // 默认深色：这个作品的基调是深色玻璃拟态（顶栏的主题按钮可在 深色 / 浅色 / 跟随系统 间循环）。
  const fallback = { repos: [], repo: undefined, view: "log", allBranches: true, ref: undefined, theme: "dark" };
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null");
    if (!raw || typeof raw !== "object") return fallback;
    return { ...fallback, ...raw, repos: Array.isArray(raw.repos) ? raw.repos.filter((item) => item && typeof item.path === "string") : [] };
  } catch {
    return fallback;
  }
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch (error) {
    errors.push(`保存偏好失败：${error}`);
  }
}

function rememberRepo(repo) {
  const entry = { path: repo.path, name: repo.name, root: repo.root };
  prefs.repos = [entry, ...prefs.repos.filter((item) => item.path.toLowerCase() !== repo.path.toLowerCase())].slice(0, 12);
  prefs.repo = repo.path;
  savePrefs();
}

function applyTheme() {
  if (prefs.theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = prefs.theme;
}

// —— 状态 ——

const state = {
  repo: undefined,
  refs: { branches: [], tags: [] },
  view: prefs.view === "status" ? "status" : "log",
  commits: [],
  hasMore: false,
  loading: false,
  paging: false,
  allBranches: prefs.allBranches !== false,
  ref: prefs.ref,
  query: "",
  selectedSha: undefined,
  detail: undefined,
  detailLoading: false,
  openFile: undefined,
  patch: undefined,
  patchLoading: false,
  status: undefined,
  statusLoading: false
};

// —— 渲染：顶栏 / 侧栏 ——

function renderRepoButton() {
  dom.repoName.textContent = state.repo ? state.repo.name : "未选择仓库";
  dom.repoBranch.textContent = state.repo?.branch && !state.repo.detached ? state.repo.branch : state.repo?.detached ? "分离 HEAD" : "";
  dom.repoButton.title = state.repo ? state.repo.root : "选择要查看的仓库";}

function renderRepoMenu() {
  clear(dom.repoMenuList);
  if (prefs.repos.length === 0) {
    dom.repoMenuList.append(el("div", "repo-menu-head", "还没有打开过仓库，在下面填一个路径"));
  }
  for (const entry of prefs.repos) {
    const button = el("button", `repo-menu-item${entry.path === state.repo?.path ? " is-active" : ""}`);
    button.type = "button";
    button.append(el("strong", undefined, entry.name || entry.path));
    button.append(el("small", undefined, entry.root || entry.path));
    button.addEventListener("click", () => {
      closeRepoMenu();
      void openRepo(entry.path);
    });
    dom.repoMenuList.append(button);
  }
}

function closeRepoMenu() {
  dom.repoMenu.hidden = true;
  dom.repoPicker.classList.remove("is-open");
  dom.repoButton.setAttribute("aria-expanded", "false");
}

function renderSidebar() {
  clear(dom.branchList);
  // 排序：当前分支 → 本地分支 → 远程分支，同组按名字（面板一打开就知道自己在哪）。
  const branches = [...(state.refs.branches ?? [])].sort((left, right) => {
    if (Boolean(left.current) !== Boolean(right.current)) return left.current ? -1 : 1;
    if (left.kind !== right.kind) return left.kind === "local" ? -1 : 1;
    return left.name.localeCompare(right.name);
  });
  dom.branchCount.textContent = String(branches.length);
  for (const branch of branches) {
    const item = el("button", `ref-item${branch.current ? " is-current" : ""}`);
    item.type = "button";
    item.title = `${branch.name} · ${branch.sha.slice(0, 10)}`;
    const iconNode = icon(ICONS.branch);
    iconNode.setAttribute("class", "ico");
    item.append(iconNode);
    const name = el("span", "ref-name", branch.name);
    item.append(name);
    if (branch.kind === "remote") item.append(el("span", "badge", "远程"));
    item.append(el("span", "ref-sha", branch.sha.slice(0, 7)));
    item.addEventListener("click", () => {
      state.ref = branch.name;
      prefs.ref = branch.name;
      if (branch.kind === "local") {
        state.allBranches = false;
        prefs.allBranches = false;
        dom.allBranches.checked = false;
      }
      savePrefs();
      renderClearRef();
      void reloadCommits();
    });
    dom.branchList.append(item);
  }

  clear(dom.tagList);
  const tags = state.refs.tags ?? [];
  dom.tagCount.textContent = String(tags.length);
  for (const tag of tags) {
    const item = el("button", "ref-item");
    item.type = "button";
    item.title = `${tag.name} · ${tag.sha.slice(0, 10)}`;
    const iconNode = icon(ICONS.tag);
    iconNode.setAttribute("class", "ico");
    item.append(iconNode);
    item.append(el("span", "ref-name", tag.name));
    item.append(el("span", "ref-sha", tag.sha.slice(0, 7)));
    item.addEventListener("click", () => {
      state.ref = tag.name;
      prefs.ref = tag.name;
      savePrefs();
      renderClearRef();
      void reloadCommits();
    });
    dom.tagList.append(item);
  }

  clear(dom.repoMeta);
  const facts = state.repo
    ? [
        ["路径", state.repo.root],
        ["分支", state.repo.detached ? "分离 HEAD" : state.repo.branch || "—"],
        ["HEAD", state.repo.head ? state.repo.head.slice(0, 10) : "空仓库"],
        ["远端", state.repo.remote ?? "—"]
      ]
    : [];
  for (const [key, value] of facts) {
    dom.repoMeta.append(el("dt", undefined, key));
    dom.repoMeta.append(el("dd", undefined, value));
  }
  renderClearRef();
}

function renderClearRef() {
  dom.clearRefBtn.hidden = !state.ref;
  dom.clearRefBtn.textContent = state.ref ? `清除过滤：${state.ref}` : "";
}

// —— 渲染：提交列表 ——

function laneColor(index) {
  return `var(--lane-${index % 8})`;
}

function graphSvg(row) {
  const width = Math.max(row.laneCount * LANE_W, LANE_W);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "graph");
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(ROW_H));
  svg.setAttribute("viewBox", `0 0 ${width} ${ROW_H}`);
  const x = (lane) => LANE_X0 + lane * LANE_W;
  const mid = ROW_H / 2;
  for (const edge of row.edges) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("stroke-linecap", "round");
    if (edge.kind === "merge") {
      path.setAttribute("stroke", laneColor(edge.from));
      path.setAttribute("d", `M ${x(edge.from)} 0 C ${x(edge.from)} ${mid * 0.55}, ${x(edge.to)} ${mid * 0.45}, ${x(edge.to)} ${mid}`);
    } else if (edge.kind === "branch") {
      path.setAttribute("stroke", laneColor(edge.to));
      path.setAttribute("d", `M ${x(edge.from)} ${mid} C ${x(edge.from)} ${mid * 1.45}, ${x(edge.to)} ${mid * 1.55}, ${x(edge.to)} ${ROW_H}`);
    } else {
      path.setAttribute("stroke", laneColor(edge.from));
      path.setAttribute("d", `M ${x(edge.from)} 0 L ${x(edge.to)} ${ROW_H}`);
    }
    svg.append(path);
  }
  const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
  dot.setAttribute("cx", String(x(row.lane)));
  dot.setAttribute("cy", String(mid));
  dot.setAttribute("r", "4");
  dot.setAttribute("fill", laneColor(row.color));
  dot.setAttribute("stroke", "var(--bg)");
  dot.setAttribute("stroke-width", "1.5");
  svg.append(dot);
  return svg;
}

function refBadges(refs) {
  const box = el("span", "refs");
  for (const ref of refs.slice(0, 4)) {
    const kind = ref.kind === "head" ? "is-head" : ref.kind === "tag" ? "is-tag" : "";
    box.append(el("span", `ref-badge ${kind}`, ref.name));
  }
  if (refs.length > 4) box.append(el("span", "ref-badge", `+${refs.length - 4}`));
  return box;
}

function commitRowNode(commit, row) {
  const button = el("button", `commit-row${state.selectedSha === commit.sha ? " is-active" : ""}`);
  button.type = "button";
  button.dataset.sha = commit.sha;
  button.style.setProperty("--graph-w", `${Math.max(row.laneCount * LANE_W, LANE_W) + 6}px`);
  button.append(graphSvg(row));

  const main = el("div", "commit-main");
  const subject = el("div", "commit-subject");
  subject.append(el("span", "text", highlighted(commit.subject || "(无提交信息)", state.query)));
  if (commit.refs.length) subject.append(refBadges(commit.refs));
  main.append(subject);
  const meta = el("div", "commit-meta");
  meta.append(el("span", "sha", commit.shortSha));
  meta.append(el("span", "author", commit.author));
  main.append(meta);
  button.append(main);
  button.append(el("span", "when", relTime(commit.epoch)));
  button.addEventListener("click", () => void selectCommit(commit.sha));
  return button;
}

function filteredCommits() {
  if (!state.query) return state.commits.map((commit, index) => ({ commit, index }));
  const needle = state.query.toLowerCase();
  return state.commits
    .map((commit, index) => ({ commit, index }))
    .filter(({ commit }) =>
      commit.subject.toLowerCase().includes(needle) ||
      commit.author.toLowerCase().includes(needle) ||
      commit.sha.toLowerCase().includes(needle) ||
      commit.shortSha.toLowerCase().includes(needle)
    );
}

function renderList() {
  clear(dom.listRows);
  if (state.view === "status") {
    renderStatusList();
    return;
  }
  const items = filteredCommits();
  const rows = layoutGraph(items.map(({ commit }) => commit));
  dom.listTitle.textContent = state.query ? `搜索结果（${items.length}）` : "提交历史";
  dom.listSub.textContent = state.commits.length
    ? state.query
      ? `在已加载的 ${state.commits.length} 条里匹配${state.hasMore ? "（更早的提交还没加载）" : ""}`
      : `已加载 ${state.commits.length} 条${state.hasMore ? " · 滚动继续加载" : ""}`
    : "";
  dom.allBranchesToggle.classList.remove("is-hidden");

  if (state.loading && state.commits.length === 0) {
    for (let index = 0; index < 8; index += 1) {
      const skeleton = el("div", "skeleton-row");
      skeleton.append(el("div", "skeleton w40"));
      skeleton.append(el("div", "skeleton w70"));
      skeleton.append(el("div", "skeleton w20"));
      dom.listRows.append(skeleton);
    }
    return;
  }
  if (!state.repo) return;
  if (items.length === 0) {
    const box = el("div", "placeholder");
    const badge = el("div", "ph-icon");
    badge.append(icon(ICONS.clock));
    box.append(badge);
    box.append(el("h4", undefined, state.query ? "没有匹配的提交" : "还没有提交"));
    box.append(el("p", undefined, state.query ? "换个关键词试试，或者往下滚动加载更早的提交。" : "这个仓库还没有任何提交。"));
    dom.listRows.append(box);
    return;
  }
  for (const [position, item] of items.entries()) {
    const graphRow = rows[position];
    if (!graphRow) continue;
    dom.listRows.append(commitRowNode(item.commit, graphRow));
  }
}

// —— 渲染：提交详情 ——

function detailPlaceholder(title, body, actions) {
  const box = el("div", "placeholder");
  const badge = el("div", "ph-icon");
  badge.append(icon(ICONS.plug));
  box.append(badge);
  box.append(el("h4", undefined, title));
  if (body) box.append(el("p", undefined, body));
  if (actions?.length) {
    const row = el("div", "actions");
    for (const action of actions) {
      const button = el("button", action.primary ? "primary" : undefined, action.label);
      button.type = "button";
      button.addEventListener("click", action.run);
      row.append(button);
    }
    box.append(row);
  }
  return box;
}

/** 提交正文过长时默认折叠（详情头部不该把变更文件挤到屏幕外）。 */
const BODY_COLLAPSE_CHARS = 320;

function renderDetail() {
  clear(dom.detailPane);
  if (state.view === "status") {
    renderStatusDetail();
    return;
  }
  if (!state.repo) {
    dom.detailPane.append(detailPlaceholder("选一个仓库", "上面的仓库选择器里可以粘贴任意本地仓库路径。"));
    return;
  }
  if (!state.selectedSha) {
    dom.detailPane.append(detailPlaceholder("选一个提交", "左侧列表里点任意一条提交，这里显示作者、时间、变更文件与补丁。"));
    return;
  }
  if (state.detailLoading) {
    const skeleton = el("div", "detail-head");
    skeleton.append(el("div", "skeleton w70"));
    skeleton.append(el("div", "skeleton w40"));
    dom.detailPane.append(skeleton);
    return;
  }
  const detail = state.detail;
  if (!detail) {
    dom.detailPane.append(detailPlaceholder("读不到这个提交", "可能是仓库被改动过，刷新试试。"));
    return;
  }

  const head = el("div", "detail-head");
  const subjectRow = el("div", "detail-subject");
  subjectRow.append(el("h2", undefined, detail.commit.subject || "(无提交信息)"));
  const copy = el("button", "copy-btn", detail.commit.shortSha);
  copy.type = "button";
  copy.title = "复制完整 SHA";
  copy.addEventListener("click", () => copyText(detail.commit.sha));
  subjectRow.append(copy);
  head.append(subjectRow);
  if (detail.commit.body) {
    const body = el("pre", "detail-body", detail.commit.body);
    if (detail.commit.body.length > BODY_COLLAPSE_CHARS) {
      body.classList.add("is-collapsed");
      const toggle = el("button", "body-toggle", "展开完整提交信息");
      toggle.type = "button";
      toggle.addEventListener("click", () => {
        const collapsed = body.classList.toggle("is-collapsed");
        toggle.textContent = collapsed ? "展开完整提交信息" : "收起提交信息";
      });
      head.append(body, toggle);
    } else {
      head.append(body);
    }
  }

  const facts = el("dl", "detail-facts");
  const pushFact = (key, value, mono = false) => {
    facts.append(el("dt", undefined, key));
    const dd = el("dd", mono ? "mono" : undefined, value);
    facts.append(dd);
    return dd;
  };
  pushFact("作者", `${detail.commit.author} <${detail.commit.email}>`);
  pushFact("时间", new Date(detail.commit.date || detail.commit.epoch * 1000).toLocaleString(), true);
  const parents = el("dd", "mono");
  if (detail.commit.parents.length === 0) {
    parents.append(document.createTextNode("（根提交）"));
  } else {
    for (const parent of detail.commit.parents) {
      const link = el("button", "parent-link", parent.slice(0, 10));
      link.type = "button";
      link.addEventListener("click", () => void selectCommit(parent));
      parents.append(link, document.createTextNode(" "));
    }
  }
  facts.append(el("dt", undefined, "父提交"));
  facts.append(parents);
  if (detail.commit.refs.length) pushFact("引用", detail.commit.refs.map((ref) => ref.name).join("、"), true);
  head.append(facts);
  dom.detailPane.append(head);

  const sectionHead = el("div", "section-head");
  sectionHead.append(el("h3", undefined, `${detail.stats.files} 个文件变更`));
  sectionHead.append(el("span", "spacer"));
  const stats = el("span", "stat-pill");
  stats.append(el("span", "plus", `+${detail.stats.add}`));
  stats.append(el("span", "minus", `-${detail.stats.del}`));
  sectionHead.append(stats);
  dom.detailPane.append(sectionHead);

  const list = el("div", "file-list");
  for (const file of detail.files) {
    list.append(fileRowNode(file, detail.commit.sha));
  }
  dom.detailPane.append(list);
}

function fileRowNode(file, sha) {
  const open = state.openFile === file.path;
  const row = el("button", `file-row${open ? " is-open" : ""}`);
  row.type = "button";
  row.append(el("span", "file-status", STATUS_LABEL[file.status] ?? file.status));
  row.querySelector(".file-status").dataset.status = file.status;
  const path = el("span", "file-path", file.path);
  path.title = file.oldPath ? `${file.oldPath} → ${file.path}` : file.path;
  row.append(path);
  const nums = el("span", "file-nums");
  if (file.binary) nums.append(el("span", "binary", "二进制"));
  else {
    if (file.add) nums.append(el("span", "plus", `+${file.add}`));
    if (file.del) nums.append(el("span", "minus", `-${file.del}`));
    if (!file.add && !file.del) nums.append(el("span", "binary", "无行变更"));
  }
  row.append(nums);
  row.addEventListener("click", () => void toggleFile(file, sha));
  const wrapper = el("div");
  wrapper.append(row);
  if (open) wrapper.append(diffNode());
  return wrapper;
}

function diffNode() {
  const box = el("div", "diff-box");
  const toolbar = el("div", "diff-toolbar");
  toolbar.append(el("span", undefined, state.patch?.truncated ? "补丁过大，已截断" : "补丁"));
  toolbar.append(el("span", "spacer"));
  if (state.patch) {
    const copy = el("button", undefined, "复制补丁");
    copy.type = "button";
    copy.addEventListener("click", () => copyText(state.patch.patch));
    toolbar.append(copy);
  }
  box.append(toolbar);
  if (state.patchLoading) {
    const skeleton = el("div", "detail-head");
    skeleton.append(el("div", "skeleton w70"));
    skeleton.append(el("div", "skeleton w40"));
    box.append(skeleton);
    return box;
  }
  if (!state.patch) {
    box.append(el("div", "placeholder", el("p", undefined, "没有补丁内容（可能是二进制文件或纯改名）。")));
    return box;
  }
  const table = el("table", "diff-table");
  const tbody = el("tbody");
  const allLines = parsePatch(state.patch.patch);
  // 超大补丁（几万行）不一次性铺进 DOM：截断渲染并如实告知（避免面板卡死）。
  const MAX_RENDER_LINES = 3000;
  const truncated = allLines.length > MAX_RENDER_LINES;
  const lines = truncated ? allLines.slice(0, MAX_RENDER_LINES) : allLines;
  for (const line of lines) {
    const tr = el("tr", `diff-line-${line.kind}`);
    const oldCell = el("td", "num");
    const newCell = el("td", "num");
    if (line.oldNo !== undefined) oldCell.textContent = String(line.oldNo);
    if (line.newNo !== undefined) newCell.textContent = String(line.newNo);
    const codeCell = el("td", "code");
    if (line.kind === "add") codeCell.append(el("span", "diff-mark", "+"));
    else if (line.kind === "del") codeCell.append(el("span", "diff-mark", "-"));
    else if (line.kind === "ctx") codeCell.append(el("span", "diff-mark", " "));
    if (line.kind === "add" || line.kind === "del" || line.kind === "ctx") {
      for (const token of tokenize(line.text)) {
        codeCell.append(token.type === "plain" ? document.createTextNode(token.text) : el("span", `tok-${token.type}`, token.text));
      }
    } else {
      codeCell.textContent = line.text;
    }
    tr.append(oldCell, newCell, codeCell);
    tbody.append(tr);
  }
  table.append(tbody);
  box.append(table);
  if (truncated) box.append(el("div", "placeholder", el("p", undefined, `补丁太长，只渲染了前 ${MAX_RENDER_LINES} 行（共 ${allLines.length} 行）。完整内容可以点上面的「复制补丁」。`)));
  return box;
}

/** 极简补丁解析：只区分 hunk 头、文件元信息、增/删/上下文行，并给出两侧行号。 */
function parsePatch(text) {
  const rows = [];
  let oldNo = 0;
  let newNo = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(line);
      if (match) {
        oldNo = Number(match[1]);
        newNo = Number(match[2]);
      }
      rows.push({ kind: "hunk", text: line });
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity |rename |Binary files|old mode|new mode|mode change)/u.test(line)) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("\\")) {
      rows.push({ kind: "meta", text: line });
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), newNo });
      newNo += 1;
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldNo });
      oldNo += 1;
      continue;
    }
    rows.push({ kind: "ctx", text: line.replace(/^ /u, ""), oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }
  while (rows.length && rows[rows.length - 1].text === "") rows.pop();
  return rows;
}

const KEYWORDS = new Set([
  "const", "let", "var", "function", "return", "if", "else", "for", "while", "class", "new", "import", "export", "from",
  "await", "async", "try", "catch", "finally", "throw", "typeof", "instanceof", "null", "undefined", "true", "false",
  "this", "super", "extends", "interface", "type", "enum", "public", "private", "protected", "readonly", "static",
  "void", "as", "in", "of", "default", "break", "continue", "switch", "case", "do", "yield", "def", "self", "None",
  "True", "False", "elif", "lambda", "pass", "raise", "with", "end", "then", "fi", "done", "esac", "select", "fmt"
]);

/** 轻量着色：注释 / 字符串 / 数字 / 关键字。误判只影响颜色，不影响内容。 */
function tokenize(line) {
  const out = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index];
    // 注释只认「行首或空白后」的 `//` / `#`：宽泛匹配会把 `_//_`、`http://x`、`a#b` 这类
    // 正文片段也染成注释色（实测在 markdown 与 URL 上很难看）。
    const atLineStart = index === 0 || /\s/u.test(line[index - 1] ?? "");
    if (atLineStart && ((char === "/" && line[index + 1] === "/") || char === "#")) {
      out.push({ type: "comment", text: line.slice(index) });
      break;
    }
    if (char === '"' || char === "'" || char === "`") {
      let cursor = index + 1;
      while (cursor < line.length && line[cursor] !== char) {
        if (line[cursor] === "\\") cursor += 1;
        cursor += 1;
      }
      const end = Math.min(cursor + 1, line.length);
      out.push({ type: "string", text: line.slice(index, end) });
      index = end;
      continue;
    }
    if (/[0-9]/u.test(char) && !/[\w$]/u.test(line[index - 1] ?? "")) {
      let cursor = index;
      while (cursor < line.length && /[0-9a-fA-FxX._]/u.test(line[cursor])) cursor += 1;
      out.push({ type: "number", text: line.slice(index, cursor) });
      index = cursor;
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      let cursor = index;
      while (cursor < line.length && /[\w$]/u.test(line[cursor])) cursor += 1;
      const word = line.slice(index, cursor);
      out.push({ type: KEYWORDS.has(word) ? "keyword" : "plain", text: word });
      index = cursor;
      continue;
    }
    let cursor = index;
    while (cursor < line.length && !/[\w$"'`#]/u.test(line[cursor]) && !(line[cursor] === "/" && line[cursor + 1] === "/")) cursor += 1;
    if (cursor === index) cursor = index + 1;
    out.push({ type: "plain", text: line.slice(index, cursor) });
    index = cursor;
  }
  return out;
}

// —— 渲染：工作区状态 ——

function renderStatusList() {
  dom.listTitle.textContent = "工作区";
  dom.listSub.textContent = state.status ? (state.status.hasUpstream ? `领先 ${state.status.ahead} · 落后 ${state.status.behind}` : "无上游分支") : "";
  dom.allBranchesToggle.classList.add("is-hidden");
  if (!state.repo) return;
  if (state.statusLoading) {
    for (let index = 0; index < 6; index += 1) {
      const skeleton = el("div", "skeleton-row");
      skeleton.append(el("div", "skeleton w20"));
      skeleton.append(el("div", "skeleton w70"));
      skeleton.append(el("div", "skeleton w20"));
      dom.listRows.append(skeleton);
    }
    return;
  }
  const status = state.status;
  if (!status) {
    dom.listRows.append(detailPlaceholder("读不到工作区状态", "刷新试试。"));
    return;
  }
  const groups = [
    ["已暂存", status.staged, "index"],
    ["未暂存", status.unstaged, "worktree"],
    ["未跟踪", status.untracked, "untracked"]
  ];
  const total = status.stats.staged + status.stats.unstaged + status.stats.untracked;
  if (total === 0) {
    dom.listRows.append(detailPlaceholder("工作区是干净的", `${status.detached ? "分离 HEAD" : status.branch || "当前分支"} 上没有未提交的改动。`));
    return;
  }
  for (const [title, rows, mode] of groups) {
    if (!rows.length) continue;
    const group = el("div", "status-group");
    const head = el("div", "status-group-head");
    head.append(el("span", undefined, title));
    head.append(el("span", "count", String(rows.length)));
    group.append(head);
    for (const row of rows) {
      const node = el("div", "status-row");
      node.append(el("span", "code", WORKTREE_STATUS[row.status ?? "?"] ?? row.status ?? "?"));
      const path = el("span", "path", row.path);
      path.title = row.oldPath ? `${row.oldPath} → ${row.path}` : row.path;
      node.append(path);
      if (row.oldPath) node.append(el("span", "old", `← ${row.oldPath}`));
      else node.append(el("span"));
      // 未跟踪项里 git 会把整个目录聚合成一条（`works/`）：目录本身没有内容可预览，
      // 点了只会报错，所以那一类不绑事件，只给光标与提示上的区别。
      const isDirectory = row.path.endsWith("/");
      const clickable = Boolean(mode) && !isDirectory;
      if (clickable) {
        node.style.cursor = "pointer";
        node.title = mode === "untracked" ? "点击查看文件内容" : "点击查看未提交的改动";
        node.addEventListener("click", () => void toggleWorktreeFile(row, mode));
      } else if (isDirectory) {
        node.title = "未跟踪目录（git 按目录聚合，展开请在文件管理器里看）";
        node.classList.add("is-dir");
      }
      group.append(node);
    }
    dom.listRows.append(group);
  }
}

function renderStatusDetail() {
  // 与 renderDetail 一致：每次重渲染先清空（少了这一行，点一个文件就多叠一份卡片）。
  clear(dom.detailPane);
  if (!state.repo) {
    dom.detailPane.append(detailPlaceholder("选一个仓库", "上面的仓库选择器里可以粘贴任意本地仓库路径。"));
    return;
  }
  if (!state.status) {
    dom.detailPane.append(detailPlaceholder("工作区", "左侧点文件可以看它的未提交改动。"));
    return;
  }
  const head = el("div", "detail-head");
  head.append(el("h2", undefined, state.status.detached ? "分离 HEAD" : state.status.branch || "工作区"));
  const facts = el("dl", "detail-facts");
  const rows = [
    ["已暂存", String(state.status.stats.staged)],
    ["未暂存", String(state.status.stats.unstaged)],
    ["未跟踪", String(state.status.stats.untracked)],
    ["相对上游", state.status.hasUpstream ? `领先 ${state.status.ahead} / 落后 ${state.status.behind}` : "无上游分支"]
  ];
  for (const [key, value] of rows) {
    facts.append(el("dt", undefined, key));
    facts.append(el("dd", "mono", value));
  }
  head.append(facts);
  dom.detailPane.append(head);
  if (state.openFile && state.patch !== undefined) {
    const sectionHead = el("div", "section-head");
    // openFile 是 `mode:path`（工作区视图）；提交视图里就是 path。标题只取文件名。
    const name = state.openFile.replace(/^[a-z]+:/u, "").split("/").pop();
    sectionHead.append(el("h3", "file-title", name));
    dom.detailPane.append(sectionHead);
    dom.detailPane.append(diffNode());
  }
}

// —— 动作 ——

function setLoading(value) {
  state.loading = value;
  dom.refreshBtn.classList.toggle("is-spinning", value);
}

async function reloadCommits() {
  if (!state.repo || state.view !== "log") return;
  setLoading(true);
  state.commits = [];
  state.hasMore = false;
  state.selectedSha = undefined;
  state.detail = undefined;
  renderList();
  await loadMore(true);
  setLoading(false);
}

async function loadMore(reset = false) {
  if (!state.repo || state.paging) return;
  if (!reset && !state.hasMore) return;
  state.paging = true;
  try {
    const payload = await api("/api/log", {
      path: state.repo.root ?? state.repo.path,
      skip: reset ? 0 : state.commits.length,
      limit: PAGE_SIZE,
      all: state.allBranches ? 1 : 0,
      ref: state.ref
    });
    state.commits = reset ? payload.commits : [...state.commits, ...payload.commits];
    state.hasMore = payload.hasMore;
    renderList();
  } catch (error) {
    errors.push(`加载提交失败：${error}`);
    toast(`加载提交失败：${error.message}`, true);
    state.hasMore = false;
  } finally {
    state.paging = false;
  }
}

async function openRepo(path) {
  if (!path) return;
  setLoading(true);
  try {
    const repo = await api("/api/repo", { path });
    state.repo = repo;
    rememberRepo(repo);
    renderRepoButton();
    renderRepoMenu();
    state.ref = undefined;
    prefs.ref = undefined;
    savePrefs();

    const [refs] = await Promise.all([
      api("/api/refs", { path: repo.root ?? repo.path }),
      reloadCommits()
    ]);
    state.refs = refs;
    renderSidebar();
    renderDetail();
    if (state.view === "status") await reloadStatus();
  } catch (error) {
    errors.push(`打开仓库失败：${error}`);
    toast(`打开仓库失败：${error.message}`, true);
    state.repo = undefined;
    renderRepoButton();
    renderSidebar();
    renderList();
    renderDetail();
  } finally {
    setLoading(false);
  }
}

async function reloadStatus() {
  if (!state.repo) return;
  state.statusLoading = true;
  renderList();
  try {
    state.status = await api("/api/status", { path: state.repo.root ?? state.repo.path });
  } catch (error) {
    errors.push(`读取工作区失败：${error}`);
    toast(`读取工作区失败：${error.message}`, true);
    state.status = undefined;
  } finally {
    state.statusLoading = false;
    renderList();
    renderDetail();
  }
}

async function selectCommit(sha) {
  if (!sha || !state.repo) return;
  state.selectedSha = sha;
  state.detail = undefined;
  state.detailLoading = true;
  state.openFile = undefined;
  state.patch = undefined;
  renderList();
  renderDetail();
  try {
    state.detail = await api("/api/commit", { path: state.repo.root ?? state.repo.path, sha });
  } catch (error) {
    errors.push(`读取提交失败：${error}`);
    toast(`读取提交失败：${error.message}`, true);
  } finally {
    state.detailLoading = false;
    renderDetail();
  }
}

async function toggleFile(file, sha) {
  if (state.openFile === file.path) {
    state.openFile = undefined;
    state.patch = undefined;
    renderDetail();
    return;
  }
  state.openFile = file.path;
  state.patch = undefined;
  state.patchLoading = true;
  renderDetail();
  try {
    state.patch = await api("/api/diff", { path: state.repo.root ?? state.repo.path, sha, file: file.path });
  } catch (error) {
    errors.push(`读取补丁失败：${error}`);
    toast(`读取补丁失败：${error.message}`, true);
  } finally {
    state.patchLoading = false;
    renderDetail();
  }
}

async function toggleWorktreeFile(row, mode) {
  if (state.openFile === `${mode}:${row.path}`) {
    state.openFile = undefined;
    state.patch = undefined;
    renderStatusDetail();
    return;
  }
  state.openFile = `${mode}:${row.path}`;
  state.patch = undefined;
  state.patchLoading = true;
  renderStatusDetail();
  try {
    state.patch = await api("/api/diff", { path: state.repo.root ?? state.repo.path, mode, file: row.path });
  } catch (error) {
    errors.push(`读取补丁失败：${error}`);
    toast(`读取补丁失败：${error.message}`, true);
  } finally {
    state.patchLoading = false;
    renderStatusDetail();
  }
}

function setView(view) {
  state.view = view === "status" ? "status" : "log";
  prefs.view = state.view;
  savePrefs();
  // 两个视图各自的展开状态不通用（一个提交里的文件路径在「工作区」里可能不存在）：
  // 切视图时把展开项与补丁一并清掉，否则会把上一个视图的补丁残留到新视图里。
  state.openFile = undefined;
  state.patch = undefined;
  for (const tab of document.querySelectorAll(".view-tab")) {
    const active = tab.dataset.view === state.view;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  }
  renderList();
  renderDetail();
  // 两个视图的数据各自按需拉：切回历史时若还没加载过（比如上次退出时停在「工作区」）要补拉，
  // 否则会看到一个空列表（只有点刷新才出来）。
  if (state.view === "log" && state.repo && state.commits.length === 0 && !state.paging) void loadMore(true);
  if (state.view === "status" && state.repo && !state.status) void reloadStatus();
}

// —— 启动 ——

async function initialRepoPath() {
  if (prefs.repo) return prefs.repo;
  if (prefs.repos.length) return prefs.repos[0].path;
  try {
    const response = await fetch("./__pidesktop_state.json", { cache: "no-store" });
    if (response.ok) {
      const payload = await response.json();
      const workspace = payload?.app?.workspace;
      if (typeof workspace === "string" && workspace) return workspace;
    }
  } catch {
    /* 从桥的 http origin 打开时没有这个端点，正常 */
  }
  return undefined;
}

function bindEvents() {
  dom.repoButton.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = dom.repoMenu.hidden;
    renderRepoMenu();
    dom.repoMenu.hidden = !open;
    dom.repoPicker.classList.toggle("is-open", open);
    dom.repoButton.setAttribute("aria-expanded", String(open));
    if (open) dom.repoPathInput.focus();
  });
  document.addEventListener("click", (event) => {
    if (!dom.repoPicker.contains(event.target)) closeRepoMenu();
  });
  const submitRepo = () => {
    const value = dom.repoPathInput.value.trim();
    if (!value) return;
    dom.repoPathInput.value = "";
    closeRepoMenu();
    void openRepo(value);
  };
  dom.repoPathAdd.addEventListener("click", submitRepo);
  dom.repoPathInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") submitRepo();
  });

  dom.refreshBtn.addEventListener("click", () => {
    if (!state.repo) {
      toast("先选一个仓库");
      return;
    }
    void (async () => {
      try {
        state.refs = await api("/api/refs", { path: state.repo.root ?? state.repo.path });
        renderSidebar();
      } catch (error) {
        errors.push(String(error));
      }
      if (state.view === "status") {
        state.status = undefined;
        await reloadStatus();
      } else {
        await reloadCommits();
      }
    })();
  });

  dom.themeBtn.addEventListener("click", () => {
    prefs.theme = prefs.theme === "dark" ? "light" : prefs.theme === "light" ? "system" : "dark";
    savePrefs();
    applyTheme();
    toast(`主题：${prefs.theme === "system" ? "跟随系统" : prefs.theme === "dark" ? "深色" : "浅色"}`);
  });

  dom.searchInput.addEventListener("input", () => {
    state.query = dom.searchInput.value.trim();
    renderList();
  });

  dom.allBranches.addEventListener("change", () => {
    state.allBranches = dom.allBranches.checked;
    prefs.allBranches = state.allBranches;
    if (state.allBranches) {
      state.ref = undefined;
      prefs.ref = undefined;
      renderClearRef();
    }
    savePrefs();
    void reloadCommits();
  });

  dom.clearRefBtn.addEventListener("click", () => {
    state.ref = undefined;
    prefs.ref = undefined;
    state.allBranches = true;
    prefs.allBranches = true;
    dom.allBranches.checked = true;
    savePrefs();
    renderClearRef();
    void reloadCommits();
  });

  for (const tab of document.querySelectorAll(".view-tab")) {
    tab.addEventListener("click", () => setView(tab.dataset.view));
  }

  document.addEventListener("keydown", (event) => {
    const typing = event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement;
    if (event.key === "/" && !typing) {
      event.preventDefault();
      dom.searchInput.focus();
      dom.searchInput.select();
      return;
    }
    if (event.key === "Escape" && typing) {
      dom.searchInput.value = "";
      state.query = "";
      dom.searchInput.blur();
      renderList();
      return;
    }
    if (typing || state.view !== "log") return;
    if (event.key === "j" || event.key === "ArrowDown" || event.key === "k" || event.key === "ArrowUp") {
      const items = filteredCommits();
      if (items.length === 0) return;
      event.preventDefault();
      const current = items.findIndex(({ commit }) => commit.sha === state.selectedSha);
      const delta = event.key === "j" || event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(Math.max(current + delta, 0), items.length - 1);
      const target = items[current < 0 ? (delta > 0 ? 0 : items.length - 1) : next];
      if (target) {
        void selectCommit(target.commit.sha);
        requestAnimationFrame(() => {
          dom.listRows.querySelector(`[data-sha="${target.commit.sha}"]`)?.scrollIntoView({ block: "nearest" });
        });
      }
    }
  });

  new IntersectionObserver((entries) => {
    if (entries.some((entry) => entry.isIntersecting) && state.hasMore && state.view === "log" && !state.query) void loadMore();
  }, { root: dom.listScroll, rootMargin: "400px" }).observe(dom.listSentinel);
}

async function boot() {
  applyTheme();
  dom.allBranches.checked = state.allBranches;
  setView(state.view);
  bindEvents();
  renderRepoButton();
  renderRepoMenu();
  renderDetail();

  const online = await probeBridge();
  if (!online) {
    const guide = el("div", "placeholder");
    const badge = el("div", "ph-icon");
    badge.append(icon(ICONS.plug));
    guide.append(badge);
    guide.append(el("h4", undefined, "连不上本地 Git Bridge"));
    guide.append(el("p", undefined, [
      "面板需要本地服务读 git 数据。正常情况下点作品墙的「运行」会自动把它拉起来；",
      "如果这个面板是手动打开的，请在作品目录里先执行：",
      document.createElement("br"),
      el("code", undefined, "node bridge.mjs")
    ]));
    const actions = el("div", "actions");
    const retry = el("button", "primary", "重试连接");
    retry.type = "button";
    retry.addEventListener("click", () => void boot());
    actions.append(retry);
    const direct = el("button", undefined, "在浏览器里直连打开");
    direct.type = "button";
    direct.title = "桥自己把这个页面也 serve 在同一地址上（同源，零跨域）";
    direct.addEventListener("click", () => {
      location.href = `http://127.0.0.1:${BRIDGE_PORT}/`;
    });
    actions.append(direct);
    guide.append(actions);
    clear(dom.listRows);
    dom.listRows.append(guide);
    return;
  }

  const path = await initialRepoPath();
  if (path) await openRepo(path);
  else {
    renderList();
    clear(dom.listRows);
    dom.listRows.append(detailPlaceholder("先选一个仓库", "点顶栏的仓库选择器，粘贴一个本地仓库路径。"));
  }
}

void boot();

// 调试与控制台入口（真机排查用；不参与页面自身逻辑）。
window.__git_manager = { openRepo, setView, selectCommit, refresh: boot, state };
