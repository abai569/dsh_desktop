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
  assert.match(css, /\[class\*="_footerActions"\]\{gap:0/, 'footerActions 的 gap 应归零');
  assert.match(css, /\[class\*="_footerActions"\] button\{min-height:30px/,
    'footer 内各插件自带按钮应压到 30px 紧凑行高');
  assert.match(css, /\[class\*="_settingsArea"\]\{padding-top:0/, '余额行内边距应归零');
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
