'use strict';

// unit-sidebar-compact.test.js — 侧栏精简插件（dsh-sidebar-compact 0.1.0）单测。
//
// 覆盖 assets/plugins/dsh-sidebar-compact/lib/client.js：
//   1) CSS 口径：整组 _panelList 折叠 + 手机隐藏 _footerActions + 折叠头样式；
//      **反证**：不得出现 `_panelRow` 单独隐藏（内核「更多」菜单不含面板本体，
//      隐藏 panelRow 等于把面板删掉——v1.0.9 实机复现的坑）；
//   2) vm 端到端（极小 DOM 垫片）：折叠头插在 panelList 之前、点击切换 html 属性
//      与 localStorage、缺省收起；
//   3) DS Bot 工作区行按文本打标（其它行不误伤）；
//   4) 窄屏强制 ds-bot:surface=agent，宽屏不动。
//
// 运行：node --test scripts/test/unit-sidebar-compact.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PLUGIN = path.join(__dirname, '..', '..', 'assets', 'plugins', 'dsh-sidebar-compact', 'lib', 'client.js');
const SRC = fs.readFileSync(PLUGIN, 'utf8');

// ───────────────────────── 极小 DOM 垫片 ─────────────────────────

class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.id = '';
    this.className = '';
    this.attrs = Object.create(null);
    this._text = '';
    this._listeners = Object.create(null);
    this.innerHTML = '';
    this.textContent = '';
  }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  insertBefore(node, ref) {
    const i = this.children.indexOf(ref);
    if (i < 0) this.children.push(node); else this.children.splice(i, 0, node);
    node.parentNode = this;
    return node;
  }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const list = this.parentNode.children;
    return list[list.indexOf(this) + 1] || null;
  }
  fire(type, ev) {
    for (const fn of this._listeners[type] || []) fn(ev || { preventDefault() { }, stopPropagation() { } });
  }
}

/** 按插件用到的选择器子集极简匹配。 */
function matches(el, sel) {
  if (el.id && sel === '#' + el.id) return true;
  const cls = sel.match(/^\[class\*=?_?"([^"]+)"\](.*)$/);
  if (cls) {
    const token = cls[1];
    const has = String(el.className || '').includes(token);
    if (!has) return false;
    const rest = cls[2] || '';
    if (!rest) return true;
    // [data-row-key^="workspace:"]
    const attr = rest.match(/^\[([\w-]+)(\^?)=\"([^\"]*)\"\]$/);
    if (attr) {
      const v = el.getAttribute(attr[1]);
      if (v == null) return false;
      return attr[2] === '^' ? v.startsWith(attr[3]) : v === attr[3];
    }
    return false;
  }
  const attr = sel.match(/^\[([\w-]+)\^*=\"([^\"]*)\"\]$/);
  if (attr) {
    const v = el.getAttribute(attr[1]);
    return v != null && v.includes(attr[2]);
  }
  return false;
}

function querySelectorAll(root, sel) {
  const out = [];
  (function walk(n) {
    for (const c of n.children || []) {
      if (matches(c, sel)) out.push(c);
      walk(c);
    }
  })(root);
  return out;
}
function querySelector(root, sel) { return querySelectorAll(root, sel)[0] || null; }

// ───────────────────────── 沙箱执行 ─────────────────────────

function boot({ width = 400, stored = {}, workspaceRows = [] } = {}) {
  const docEl = new El('html');
  const head = new El('head');
  const body = new El('body');
  const sidebar = new El('div');
  const panelList = new El('nav');
  panelList.className = 'hHd-Xa_panelList';
  sidebar.appendChild(panelList);
  body.appendChild(sidebar);

  // 工作区行
  for (const { text, key, attrs } of workspaceRows) {
    const row = new El('div');
    row.textContent = text;
    row.setAttribute('data-row-key', key);
    if (attrs) for (const [k, v] of Object.entries(attrs)) row.setAttribute(k, v);
    sidebar.appendChild(row);
  }

  const store = { ...stored };
  const doc = {
    documentElement: docEl,
    head,
    body,
    readyState: 'complete',
    createElement: (t) => new El(t),
    getElementById(id) {
      if (id === docEl.id) return docEl;
      const all = [...head.children, ...body.children];
      const deep = [];
      (function walk(n) { for (const c of n.children || []) { deep.push(c); walk(c); } })(body);
      return all.find((e) => e.id === id) || deep.find((e) => e.id === id) || null;
    },
    querySelector: (sel) => querySelector(body, sel),
    querySelectorAll: (sel) => querySelectorAll(body, sel),
    addEventListener() { },
  };

  let loaded = null;
  const win = {
    document: doc,
    innerWidth: width,
    localStorage: {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
    },
    matchMedia: (q) => ({ matches: width <= 720, media: q, addEventListener() { } }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => { fn(); return 1; },
    setInterval: () => 1,
    __ModuleLoader__: { load(cfg) { loaded = cfg; } },
  };

  const sandbox = {
    window: win, document: doc, console,
    localStorage: win.localStorage,
    MutationObserver: class { observe() { } },
    requestAnimationFrame: win.requestAnimationFrame,
    setTimeout: win.setTimeout,
    setInterval: () => 1,
  };
  sandbox.globalThis = sandbox;
  sandbox.window.window = win;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 3000 });

  const exportsObj = loaded.factory();
  exportsObj.apply();

  return { doc, docEl, body, panelList, store, win, exportsObj, core: win.__dshSidebarCompactCore };
}

// ───────────────────────── 1. 静态口径 ─────────────────────────

test('注册形态：id 正确、inject 为空（纯客户端）', () => {
  const { exportsObj } = boot();
  assert.ok(exportsObj, 'factory 应返回 exports');
  // 注意：沙箱里创建的数组与测试 realm 的 Array 原型不同，不能用 deepStrictEqual 比空数组。
  assert.ok(Array.isArray(exportsObj.inject), 'inject 应是数组');
  assert.equal(exportsObj.inject.length, 0, 'inject 必须为空（不依赖任何宿主服务）');
  assert.equal(typeof exportsObj.apply, 'function');
});

test('CSS 口径：整组折叠 + 手机隐藏 footerActions + 折叠头样式 + 配对 iPhone 精准隐藏', () => {
  const css = boot().core.CSS;
  assert.match(css, /html\[data-dsh-panel-collapsed="1"\] \[class\*="_panelList"\]\{display:none/,
    '折叠必须作用于整组 _panelList');
  assert.match(css, /\[class\*="_footerActions"\]\{display:none/, '手机应整块隐藏 footerActions');
  assert.match(css, /@media \(max-width: 720px\)/, '手机断点应是 720px');
  assert.match(css, /#dsh-panel-toggle\{/, '必须有折叠头样式');
  assert.match(css, /rotate\(-90deg\)/, '折叠态箭头应旋转');
  // 配对 iPhone：桌面端也要隐藏（手机端另有 footerActions 整块隐藏兜底）。
  // 该规则必须出现在 @media 之外——写成「只对手机生效」就退回 v1.0.9 的老毛病。
  assert.match(css, /button\[data-dsh-plugin="remote-bridge"\]\[data-dsh-part="entry"\]\{display:none/,
    '配对 iPhone 入口必须按 remote-bridge 的稳定属性精准隐藏');
  const mediaAt = css.indexOf('@media (max-width: 720px)');
  const bridgeAt = css.indexOf('data-dsh-plugin="remote-bridge"');
  assert.ok(bridgeAt >= 0 && bridgeAt < mediaAt,
    '配对 iPhone 隐藏规则必须在 @media 之外（否则桌面端又冒出来）');
});

test('反证：不得单独隐藏 _panelRow（那会把面板本体删掉）', () => {
  const css = boot().core.CSS;
  assert.ok(!css.includes('_panelRow'),
    'CSS 里不许出现 _panelRow —— 内核「更多」菜单只含 sidebar.panellist.actions，不含面板本体，单独隐藏等于删面板');
});

// ───────────────────────── 2. 折叠头行为 ─────────────────────────

test('折叠头：插在 panelList 之前、缺省收起、点击可来回切换', () => {
  const { doc, docEl, panelList } = boot();
  const toggle = doc.getElementById('dsh-panel-toggle');
  assert.ok(toggle, '折叠头应被注入');
  assert.equal(toggle.nextElementSibling, panelList, '折叠头必须紧贴在 panelList 之前');
  assert.equal(docEl.getAttribute('data-dsh-panel-collapsed'), '1', '缺省应为收起');

  toggle.fire('click');
  assert.equal(docEl.getAttribute('data-dsh-panel-collapsed'), '0', '点击后应展开');

  toggle.fire('click');
  assert.equal(docEl.getAttribute('data-dsh-panel-collapsed'), '1', '再点应收回');
});

test('折叠状态持久化到 localStorage', () => {
  const { doc, store } = boot();
  const toggle = doc.getElementById('dsh-panel-toggle');
  toggle.fire('click');
  assert.equal(store['dsh-sidebar-compact:collapsed'], '0', '展开应写入 0');
  toggle.fire('click');
  assert.equal(store['dsh-sidebar-compact:collapsed'], '1', '收起应写入 1');
});

test('尊重已存状态：localStorage 记 0 时首屏即展开', () => {
  const { docEl } = boot({ stored: { 'dsh-sidebar-compact:collapsed': '0' } });
  assert.equal(docEl.getAttribute('data-dsh-panel-collapsed'), '0');
});

test('无 panelList 时不炸（panels 为空的内核形态）', () => {
  const docEl = new El('html');
  const head = new El('head');
  const body = new El('body');
  const doc = {
    documentElement: docEl, head, body, readyState: 'complete',
    createElement: (t) => new El(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() { },
  };
  let loaded = null;
  const win = {
    document: doc, innerWidth: 400,
    localStorage: { getItem: () => null, setItem() { } },
    matchMedia: () => ({ matches: true, addEventListener() { } }),
    requestAnimationFrame: (fn) => fn(), setTimeout: (fn) => { fn(); return 1; }, setInterval: () => 1,
    __ModuleLoader__: { load(cfg) { loaded = cfg; } },
  };
  const sandbox = {
    window: win, document: doc, console, localStorage: win.localStorage,
    MutationObserver: class { observe() { } },
    requestAnimationFrame: win.requestAnimationFrame, setTimeout: win.setTimeout, setInterval: () => 1,
  };
  sandbox.globalThis = sandbox; sandbox.window.window = win;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { timeout: 3000 });
  assert.doesNotThrow(() => loaded.factory().apply(), '缺 panelList 时 apply 不得抛异常');
});

// ───────────────────────── 3. 底部间距压缩 ─────────────────────────

test('底部区块间距压缩：footArea / footerActions / settingsArea 四处都收紧', () => {
  const css = boot().core.CSS;
  assert.match(css, /\[class\*="_footArea"\]\{margin-top:2px/, 'footArea 上间距应收紧');
  assert.ok(css.includes('[class*="_footArea"] [class*="_footerActions"]{gap:0 !important;'),
    'footerActions 的 gap 应归零，且必须挂在 _footArea 下');
  assert.ok(css.includes('[class*="_footArea"] [class*="_footerActions"] button{min-height:30px !important;'),
    'footer 内各插件自带按钮应压到 30px，且必须挂在 _footArea 下');
  assert.match(css, /\[class\*="_settingsArea"\]\{padding-top:0/, '余额行内边距应归零');
});

test('反证：间距规则不得裸写 _footerActions（它不是侧栏专属）', () => {
  // v1.1.1 事故：`_footerActions` 在 dsh-client-ui-user-questions 里也有同名类，
  // 裸写会选到对话里的提问卡片、把它的按钮一起压塌。
  // 唯一允许的形态是「挂在 _footArea 下」，故任何不以 _footArea 限定的出现都判红。
  const css = boot().core.CSS;
  const hits = [...css.matchAll(/\[class\*="_footerActions"\]/g)];
  assert.ok(hits.length >= 2, '夹具前提：确实存在 footerActions 选择器');
  for (const hit of hits) {
    const before = css.slice(Math.max(0, hit.index - 40), hit.index);
    assert.ok(before.includes('[class*="_footArea"]'),
      '每处 _footerActions 都必须带 _footArea 祖先限定，裸写会误伤 user-questions：' +
      css.slice(hit.index, hit.index + 60));
  }
});

test('轮次导航器强制常驻：覆盖内核 TurnNavigator 的 900px 容器查询', () => {
  // 内核 @deepseek-ai/dsh-client-ui-chat 有一条
  //   @container (width<=900px){ .eGxaPq_frame{display:none} }
  // 容器量的是中栏宽度，窗口稍窄整条消息刻度就消失。本插件用 !important 压过它。
  const css = boot().core.CSS;
  // 用字符串断言而不是正则：`[class*="_frame"]` 在正则里是字符类，必须逐字符转义，
  // 极易在生成/复制时丢掉反斜杠而静默变成「匹配任意单字符」的假判据（本次就踩了）。
  assert.ok(css.includes('[class*="_frame"]:has(> [class*="_scroller"] > [class*="_marks"]){display:block !important;}'),
    '必须有「直接子代限定」的 TurnNavigator 常驻规则');
  // 反证（v1.1.1 灾难现场）：`:has([class*="_marks"])` 这种后代反查会命中原页面框架
  // `.pI_x6G_frame`（AppFrame：display:grid + grid-template-rows），被压成 block 后
  // 会话区与输入框一起塌掉。必须用 `> scroller > marks` 锁死层数。
  assert.ok(!css.includes(':has([class*="_marks"])'),
    ':has() 不得用后代反查，必须写成 :has(> [class*="_scroller"] > [class*="_marks"])');
  // 反证：不得出现不带 :has 限定的裸 _frame 选择器
  assert.ok(!css.includes('[class*="_frame"]{display:block'),
    '不得使用不带 :has 限定的裸 _frame 选择器');
});

test('手机端侧栏入口去重：隐藏 dsh-pocket 的浮动 fab，只留头部 toggle', () => {
  // 2026-11-04 实机：新会话（hero 阶段）左上角出现两个一模一样的侧栏图标上下堆叠。
  // dsh-pocket 两套入口本该互斥，但内核 phase 是三态 settling/hero/active，
  // hero 阶段头部 toggle 仍渲染、fab 也判定为「非 active」→ 两个都在。
  const css = boot().core.CSS;
  assert.ok(css.includes('[data-mobile-nav="fab"]{display:none !important;}'),
    '必须隐藏 dsh-pocket 的浮动 fab，否则 hero 阶段与头部 toggle 重复');
  // 断点必须与 dsh-pocket 自己的 MOBILE_QUERY（max-width: 1023px）一致，
  // 写成 720px 会在 768~1023 的窄桌面/平板上漏掉重复图标。
  assert.ok(css.includes('@media (max-width: 1023px)'),
    '去重规则必须落在 1023px 断点内（与 dsh-pocket 的 MOBILE_QUERY 同源）');
  // 反证：只许隐藏 fab，绝不能顺手隐藏 toggle（那是保留下来的唯一入口）
  assert.ok(!css.includes('[data-mobile-nav="toggle"]{display:none'),
    '不得隐藏 [data-mobile-nav="toggle"] —— 它是保留的唯一侧栏入口');
});

test('抽屉滑入用缓出曲线（用户反馈默认过渡生硬）', () => {
  const css = boot().core.CSS;
  assert.ok(css.includes('[data-mobile-nav="frame"] > :first-child{'),
    '必须有抽屉容器的过渡覆盖');
  assert.ok(css.includes('cubic-bezier(.22,1,.36,1)'),
    '过渡曲线应换成缓出 cubic-bezier(.22,1,.36,1)');
  assert.ok(css.includes('transition-duration:.26s'),
    '过渡时长应显式给定（.26s）');
});

test('反证：DS Bot 行改为保留显示，不得再有隐藏规则', () => {
  // 2026-11-04 用户改口：DS Bot 留着不隐藏，只压间距。
  const css = boot().core.CSS;
  assert.ok(!css.includes('data-dsh-hide-row'), 'CSS 里不得再有 data-dsh-hide-row 隐藏规则');
  assert.ok(!/DS\s*Bot/i.test(css), 'CSS 里不得再有 DS Bot 文本匹配规则');
});

// ───────────────────────── 4. 窄屏强制经典 ─────────────────────────

test('窄屏（≤720px）强制 ds-bot:surface=agent', () => {
  const { store } = boot({ width: 400 });
  assert.equal(store['ds-bot:surface'], 'agent', '窄屏应强制经典模式');
});

test('宽屏不触碰 ds-bot:surface', () => {
  const { store } = boot({ width: 1440 });
  assert.equal(store['ds-bot:surface'], undefined, '宽屏不该写 ds-bot:surface');
});

test('窄屏已是 agent 时不重复写（幂等）', () => {
  const { store } = boot({ width: 400, stored: { 'ds-bot:surface': 'agent' } });
  assert.equal(store['ds-bot:surface'], 'agent');
});
