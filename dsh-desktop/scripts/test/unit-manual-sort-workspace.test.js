'use strict';

// unit-manual-sort-workspace.test.js — K26 工作区/项目行手动排序拖拽修复单测。
//
// 补丁（patch-adapters.transformManualSortDragWorkspaceFix）对内核
// @deepseek-ai/dsh-client-ui-workspace lib/client.js 做一件事：工作区行
// ProjectRowItem 的 onDragStart 内，把 drag.start()（setWorkspaceDrag 状态提交）
// 包进 react-dom flushSync。根因与 K25 同源：React 18 批处理下状态未同步提交，
// 分组容器的 onDragOver/onDrop 因 `workspaceDrag === null` 尚未挂上，首个 dragover
// 不 preventDefault → 浏览器判定目标不可 drop → 分组拖不动。
//
// 本单测分两层：
//   1) 内容契约：flushSync 注入到工作区行（row.key）且会话行注入数不变（K25 那份）、
//      幂等、K25 缺失时按 anchor-missing 跳过、pristine 还原可剥；
//   2) 守护：K25 的既有契约（会话行 1 处）不被 K26 破坏。
//
// 运行：node --test scripts/test/unit-manual-sort-workspace.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  transformManualSortFix,
  transformManualSortDragWorkspaceFix,
  toPristineSource,
  markers,
} = require('../lib/patch-adapters');
const { WORKSPACE_PKG_REL } = require('../lib/patch-target-resolver');

const MANUAL_SORT_DRAG_WORKSPACE_MARKER = markers.MANUAL_SORT_DRAG_WORKSPACE_MARKER;
const FLUSH = 'react_dom.flushSync(() => {';

/** 定位内核 workspace client.js 靶文件（与 K25 单测同一解析序）。 */
function resolveWorkspaceSource() {
  const candidates = [
    path.join(__dirname, '..', '..', 'node_modules', '@deepseek-ai', WORKSPACE_PKG_REL),
    path.join(__dirname, '..', '..', '..', 'dsh-tauri', 'package-payload', 'dsh-desktop',
      'node_modules', '@deepseek-ai', WORKSPACE_PKG_REL),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

const WORKSPACE_PATH = resolveWorkspaceSource();
const hasSource = WORKSPACE_PATH !== null;

/** 磁盘副本 → 「K25 已应用、K26 未应用」的基线（与磁盘当前状态无关）。 */
function baseWithK25() {
  const disk = fs.readFileSync(WORKSPACE_PATH, 'utf8');
  const pristine = toPristineSource('manual-sort-drag-family', disk);
  const k25 = transformManualSortFix(pristine, 'client.js');
  assert.equal(k25.status, 'changed', '族 pristine 上应用 K25 必须 changed');
  return k25.src;
}

test('K26 transform：工作区行 onDragStart 注入 flushSync，会话行注入数不变，幂等', { skip: !hasSource }, () => {
  const base = baseWithK25();
  const r = transformManualSortDragWorkspaceFix(base, 'client.js');
  assert.equal(r.status, 'changed', '未打该补丁的源应 changed');
  const src = r.src;

  assert.ok(src.includes(MANUAL_SORT_DRAG_WORKSPACE_MARKER), '应含 K26 marker');

  // 工作区行（row.key）被包裹。
  const rowIdx = src.indexOf('e.dataTransfer.setData("text/plain", row.key);');
  assert.ok(rowIdx > 0, '应命中工作区行 setData(row.key)');
  assert.ok(src.slice(rowIdx, rowIdx + 220).includes(FLUSH), '工作区行 drag.start 应被 flushSync 包裹');

  // 会话行仍只有 K25 的那一处，K26 不重复注入。
  assert.equal(src.split(FLUSH).length - 1, 2, 'flushSync 总数应为 2（K25 会话行 + K26 工作区行）');

  // 幂等。
  assert.equal(transformManualSortDragWorkspaceFix(src, 'client.js').status, 'already');

  // pristine 还原：单独剥 K26 不碰 K25。
  const reverted = toPristineSource('manual-sort-drag-fix-workspace', src);
  assert.ok(!reverted.includes(MANUAL_SORT_DRAG_WORKSPACE_MARKER), '还原后不应残留 K26 marker');
  assert.ok(reverted.includes(markers.MANUAL_SORT_DRAG_MARKER), '还原 K26 不应动到 K25');
});

test('K26 transform：K25（react-dom require）缺失时按 anchor-missing 跳过，不半途注入', { skip: !hasSource }, () => {
  const base = baseWithK25();
  const noK25 = toPristineSource('manual-sort-drag-fix', base);
  assert.ok(!noK25.includes('let react_dom = require("react-dom");'), '应已剥掉 K25');

  const r = transformManualSortDragWorkspaceFix(noK25, 'client.js');
  assert.equal(r.status, 'anchor-missing');
  assert.ok(!noK25.includes('react_dom.flushSync'), '确实没有可复用的 react-dom 绑定');
});

test('K26 transform：锚点漂移（工作区行拖拽起点变了）时按 anchor-missing 跳过', { skip: !hasSource }, () => {
  // react-dom require 在位（K25 已应用），只让工作区行拖拽锚点对不上。
  const base = baseWithK25();
  const drifted = base.replace(
    'e.dataTransfer.setData("text/plain", row.key);\n\t\t\t\t\tdrag.start();',
    'e.dataTransfer.setData("text/plain", row.key);\n\t\t\t\t\tdrag.startSomethingElse();'
  );
  assert.notEqual(drifted, base, '夹具应确实改掉锚点');
  const r = transformManualSortDragWorkspaceFix(drifted, 'client.js');
  assert.equal(r.status, 'anchor-missing');
});
