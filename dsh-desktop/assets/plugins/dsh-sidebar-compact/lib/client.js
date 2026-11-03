// dsh-sidebar-compact — 侧栏精简（DSH Desktop 配套插件）
//
// 浏览器半边（classic-script bundle，经 __ModuleLoader__.load 注册）。
//
// 为什么必须做成客户端插件而不是壳层 bridge-shim：Tauri 的 initialization_script
// 只在桌面壳 webview 里执行，手机浏览器 / 远程访问（dsh-pocket 隧道、局域网 IP）
// 拿不到那段脚本。做成客户端插件后，内核 Web UI 加载时一并加载，桌面与手机同效。
//
// 目标（对齐用户诉求）：
//   1. 面板组折叠——内核侧栏的 nav.panelList 里放着「插件商店 / 任务看板 / 智能体 /
//      更多」四个按钮。整组折叠成一行折叠头（左侧「面板」+ 右侧 ▾），点开原样展开。
//      ⚠ 不要单独隐藏 panelRow：内核「更多」菜单里只有「浏览更多插件 / 创建你的插件」
//      两个动作，不含面板本身，隐藏 panelRow 等于把三个面板彻底删掉（已验证的坑）。
//   2. 手机（≤720px）隐藏 footArea 的 footerActions 整块（工具箱 / 手机访问 /
//      配对 iPhone 都在这个 slot 里）。
//   3. 隐藏 DS Bot 工作区行（DS Bot 的 team workspace，在工作区列表里单列一行）。
//   4. 窄屏每次打开都强制经典 Agent 模式（ds-bot 自己读写 ds-bot:surface）。
//
// 实现纪律：纯 DOM + CSS，inject 为空，不碰 react / ctx.slots；全程 try/catch 静默
// 降级；折叠头用内核未管理的自定义 id/属性（React 不会移除），MutationObserver +
// 低频兜底扫描自愈重渲染。
(function () {
  'use strict';

  // ───────────────────────── 常量 ─────────────────────────
  var KEY_COLLAPSED = 'dsh-sidebar-compact:collapsed';
  var MOBILE_MAX = 720;
  var STYLE_ID = 'dsh-sidebar-compact-style';
  var TOGGLE_ID = 'dsh-panel-toggle';
  var DSBOT_ATTR = 'data-dsh-hide-row';
  var SCAN_INTERVAL_MS = 1200;

  function isMobile() {
    try { return window.matchMedia('(max-width: ' + MOBILE_MAX + 'px)').matches; }
    catch (e) { return (window.innerWidth || 0) <= MOBILE_MAX; }
  }

  function collapsed() {
    try {
      var v = window.localStorage.getItem(KEY_COLLAPSED);
      return v === null ? true : v === '1';   // 缺省收起
    } catch (e) { return true; }
  }

  function setCollapsed(on) {
    try { window.localStorage.setItem(KEY_COLLAPSED, on ? '1' : '0'); } catch (e) { }
    apply();
  }

  // ───────────────────────── CSS ─────────────────────────
  var CSS = [
    // 折叠态：整组 panelList 收起（不是删单个按钮）
    'html[data-dsh-panel-collapsed="1"] [class*="_panelList"]{display:none !important;}',
    // 折叠头：整行、左标题右箭头，仿内核设置页那种披露行
    '#' + TOGGLE_ID + '{',
    'display:flex;align-items:center;justify-content:space-between;',
    'width:100%;box-sizing:border-box;margin:2px 0 4px;padding:7px 10px;',
    'background:transparent;border:0;border-radius:8px;',
    'color:inherit;font:inherit;font-size:13px;line-height:20px;',
    'text-align:left;cursor:pointer;opacity:.72;transition:background .12s,opacity .12s;',
    '}',
    '#' + TOGGLE_ID + ':hover{background:rgba(127,127,127,.12);opacity:1;}',
    '#' + TOGGLE_ID + ' .dsh-pt-arrow{font-size:10px;line-height:1;opacity:.8;transition:transform .15s ease;}',
    'html[data-dsh-panel-collapsed="1"] #' + TOGGLE_ID + ' .dsh-pt-arrow{transform:rotate(-90deg);}',
    // 手机：整块隐藏 footer.action（工具箱 / 手机访问 / 配对 iPhone）
    '@media (max-width: ' + MOBILE_MAX + 'px){',
    '  [class*="_footerActions"]{display:none !important;}',
    '  [class*="_regionArea"]{padding-bottom:8px !important;}',
    '}',
    // DS Bot 工作区行
    '[' + DSBOT_ATTR + '="1"]{display:none !important;}',
  ].join('\n');

  function ensureCss() {
    try {
      if (document.getElementById(STYLE_ID)) return;
      var el = document.createElement('style');
      el.id = STYLE_ID;
      el.textContent = CSS;
      (document.head || document.documentElement).appendChild(el);
    } catch (e) { /* 样式失败不挡功能 */ }
  }

  // ───────────────────────── 折叠头 ─────────────────────────
  function findPanelList() {
    try { return document.querySelector('[class*="_panelList"]'); } catch (e) { return null; }
  }

  function ensureToggle() {
    var list = findPanelList();
    if (!list || !list.parentNode) return;
    var btn = document.getElementById(TOGGLE_ID);
    if (!btn) {
      btn = document.createElement('button');
      btn.id = TOGGLE_ID;
      btn.type = 'button';
      btn.setAttribute('aria-label', '展开或收起面板');
      btn.innerHTML = '<span>面板</span><span class="dsh-pt-arrow">\u25BE</span>';
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        setCollapsed(!collapsed());
      });
    }
    // 始终紧贴在 panelList 之前（React 重渲染后自愈）
    if (btn.nextElementSibling !== list) {
      try { list.parentNode.insertBefore(btn, list); } catch (e) { }
    }
  }

  function syncCollapsedAttr() {
    try {
      var root = document.documentElement;
      var want = collapsed() ? '1' : '0';
      if (root.getAttribute('data-dsh-panel-collapsed') !== want) {
        root.setAttribute('data-dsh-panel-collapsed', want);
      }
    } catch (e) { }
  }

  // ───────────────────────── DS Bot 工作区行 ─────────────────────────
  // 内核只把 data-row-key="workspace:<uuid>" 挂到 DOM 上，没暴露路径，
  // 故按行内标题文本匹配（该工作区标题固定为 DS Bot）。
  function markDsBotRows() {
    var rows;
    try { rows = document.querySelectorAll('[data-row-key^="workspace:"]'); }
    catch (e) { return; }
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var text = (row.textContent || '').replace(/\s+/g, ' ').trim();
      var hit = /(^|\s)DS\s*Bot(\s|$)/i.test(text);
      try {
        if (hit) {
          if (row.getAttribute(DSBOT_ATTR) !== '1') row.setAttribute(DSBOT_ATTR, '1');
        } else if (row.getAttribute(DSBOT_ATTR) !== null) {
          row.removeAttribute(DSBOT_ATTR);
        }
      } catch (e) { /* 单行失败继续 */ }
    }
  }

  // ───────────────────────── 窄屏强制经典模式 ─────────────────────────
  function forceClassicOnMobile() {
    if (!isMobile()) return;
    try {
      if (window.localStorage.getItem('ds-bot:surface') !== 'agent') {
        window.localStorage.setItem('ds-bot:surface', 'agent');
      }
    } catch (e) { }
  }

  // ───────────────────────── 调度 ─────────────────────────
  function apply() {
    ensureCss();
    syncCollapsedAttr();
    ensureToggle();
    markDsBotRows();
  }

  var pending = false;
  function schedule() {
    if (pending) return;
    pending = true;
    var run = function () { pending = false; try { apply(); } catch (e) { } };
    try {
      if (window.requestAnimationFrame) window.requestAnimationFrame(run);
      else window.setTimeout(run, 16);
    } catch (e) { run(); }
  }

  var observer = null;
  var timer = null;

  function startWatch() {
    try {
      if (observer === null && typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(schedule);
        observer.observe(document.documentElement, { childList: true, subtree: true });
      }
    } catch (e) { /* 观察失败靠兜底扫描 */ }
    try {
      if (timer === null) timer = window.setInterval(function () { schedule(); }, SCAN_INTERVAL_MS);
    } catch (e) { }
    try {
      var mq = window.matchMedia('(max-width: ' + MOBILE_MAX + 'px)');
      var onMq = function () { forceClassicOnMobile(); schedule(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    } catch (e) { }
  }

  // 纯逻辑暴露（测试驱动用；生产无副作用）。
  if (typeof window !== 'undefined') {
    window.__dshSidebarCompactCore = {
      CSS: CSS,
      collapsed: collapsed,
      isMobile: isMobile,
      markDsBotRows: markDsBotRows,
      apply: apply,
    };
  }

  // ───────────────────────── 注册 ─────────────────────────
  if (typeof window !== 'undefined' && window.__ModuleLoader__) {
    window.__ModuleLoader__.load({
      id: 'dsh-sidebar-compact',
      factory: function () {
        function boot() {
          try {
            ensureCss();
            forceClassicOnMobile();
            apply();
            startWatch();
          } catch (e) { /* 侧栏精简绝不能影响宿主 */ }
        }
        function apply_noop() {
          // 平台 apply：模块加载后由内核调用一次；启动逻辑放这里幂等执行。
          boot();
        }
        var module = { exports: {} };
        module.exports = { inject: [], apply: apply_noop, core: window.__dshSidebarCompactCore };
        return module.exports;
      },
    });
  }
})();
