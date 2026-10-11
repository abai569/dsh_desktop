'use strict';

// ---------------------------------------------------------------------------
// dsh-app-boot 模块实例分裂修复（macOS 路径大小写导致「任何设置都存不了」）。
//
// 背景（2026-10-11 macOS 实机取证，两段探针日志定案，非推断）：
//
//   用户症状：点「开始设置」→ 弹「未能保存设置，请重试。」+ 引导页回滚 welcome；
//   引导之后的模型设置页也一律存不住，即「settings.mutate 全线失败」。
//
//   取证链（每一步都有日志实证，顺序即排查顺序）：
//   ① 前端注入 diag5 抓到宿主响应的 code = `settings/rejected`、details 只带
//      `{ ns }`，原始 message 被前端丢弃 → 只能进内核看。
//   ② 在 dsh-api-settings-controller 的 write() catch 里打印原始异常，得到
//      `Error: dsh: profile reload requires the root Include entry`——是内核
//      reconcileProfilePatches 取 bootstrapIncludes.get(ctx) 落空抛的，不是
//      schema/字段问题（同一轮已实测：字段含 null 与去 null 两种批次同样被拒，
//      revision 恒为 0，user 恒为 {}，写入从未成功过一次）。
//   ③ dsh-app-boot 内埋探针后出现自相矛盾的事实：`.set(ctx, entry)` 确实执行
//      （登记 total=1）、传入的 ctx 与登记的 ctx `sameCtx=true`、ctx 非空
//      （ctxHasLoader=true）、可 `.get(ctx)` 却返回 undefined。WeakMap 不可能
//      这样 ⇒ 只有一个解释：**同一份模块被加载成两个 ESM 实例，各持一份
//      模块级 WeakMap**。
//   ④ 给模块加随机指纹 + 打完整 import.meta.url，两个实例立刻现形：
//
//        mount:     mod=l6pev0  …/Contents/resources/dsh-desktop/…/dsh-app-boot/lib/index.js
//        reconcile: mod=k9wf29  …/Contents/Resources/dsh-desktop/…/dsh-app-boot/lib/index.js
//
//      只差一个字母：磁盘真实目录是 `Contents/Resources`（大写 R），而壳
//      supervisor spawn 内核时拼的是 `Contents/resources`（小写 r，日志实证
//      `[supervisor] 内核 spawn: …/Contents/resources/dsh-desktop/vendor/node/
//      node … /Contents/resources/dsh-desktop/node_modules/@deepseek-ai/dsh/
//      lib/bin.js web …`）。macOS APFS 默认大小写不敏感（同一份文件），但
//      **ESM 模块缓存按 URL 字符串区分大小写** → 同一文件被判定为两个模块。
//
//   修法：把 bootstrapIncludes 提升为 globalThis 上的单例（`??=` 惰性建），
//   两个实例取到同一张表。选「提升为全局单例」而不是「改 spawn 路径大小写」
//   的理由：spawn argv 在 Tauri Rust 壳里，改它要动壳侧并重验三平台；且
//   大小写分裂的成因不止这一处（任何经符号链接、profile fallback、
//   agent overlay 落点的二次加载都会重演），在数据侧兜住更稳且无平台面。
//
// 语义不变式：类型仍是 WeakMap（键仍为 ctx 对象、弱引用不泄漏）、get/set
// 行为逐字不变，只是表的存放位置从模块作用域移到 globalThis。同源惰性建
// 意味着「谁先进谁建」，后到者复用；卸载后 globalThis 上留一个空 WeakMap，
// 无副作用（键是 ctx，进程结束即回收）。
//
// 幂等 / 容错契约对齐 scripts/lib 既有补丁：marker 短路 already、锚点失配
// 不改写（上游原生修好或字节变形时自然退役）、异常逐文件吸收。
// ---------------------------------------------------------------------------

const path = require('node:path');

/** 目标文件（相对 node_modules/@deepseek-ai 根）。 */
const APP_BOOT_REL = path.join('dsh-app-boot', 'lib', 'index.js');

/** 幂等 marker（产物注释 + 单测同源）。 */
const BOOTSTRAP_SINGLETON_MARKER = 'dsh-desktop patch (bootstrap includes singleton)';

/** 上游原始声明（rc.2 字节形态：esbuild 产物的 /* @__PURE__ *\/ 注释）。 */
const BOOTSTRAP_ORIGINAL = 'const bootstrapIncludes = /* @__PURE__ */ new WeakMap();';

/** 注入后的单例声明（globalThis 惰性建，跨模块实例共享）。 */
const BOOTSTRAP_SINGLETON =
  'const bootstrapIncludes = globalThis.__dshBootstrapIncludes ??= /* @__PURE__ */ new WeakMap(); ' +
  '// ' + BOOTSTRAP_SINGLETON_MARKER +
  '：macOS 壳 spawn 用 Contents/resources、loader 用 Contents/Resources，' +
  '同一文件被 ESM 当成两个模块加载，模块级 WeakMap 随之分裂，' +
  'profile reload 写入链必抛「requires the root Include entry」（设置全线不可存）。';

/** 失配时同样抛的那一行——仅用于把静默 throw 变成可检索日志（平时零噪音）。 */
const RECONCILE_MISS_ORIGINAL =
  'if (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);';
const RECONCILE_MISS_NEW =
  'if (entry === void 0) { console.error("[dsh-desktop-patch] profile-reload-miss: " + binName); ' +
  'throw new Error(`${binName}: profile reload requires the root Include entry`); }';

/**
 * 把 bootstrapIncludes 提升为 globalThis 单例，并把 reconcile 落空时的静默
 * throw 补一条可检索日志。返回 { changed, src }；锚点失配时 changed=false 且
 * 不改写（调用方按 marker 判定 already / anchor-missing）。
 */
function applyBootstrapIncludesSingleton(src) {
  if (src.includes(BOOTSTRAP_SINGLETON_MARKER)) return { changed: false };
  if (!src.includes(BOOTSTRAP_ORIGINAL)) return { changed: false };
  // 两处锚点都要在：任一失配即整体不写，避免半改状态。
  if (!src.includes(RECONCILE_MISS_ORIGINAL)) return { changed: false };
  let out = src.replace(BOOTSTRAP_ORIGINAL, BOOTSTRAP_SINGLETON);
  out = out.replace(RECONCILE_MISS_ORIGINAL, RECONCILE_MISS_NEW);
  return { changed: out !== src, src: out };
}

module.exports = {
  APP_BOOT_REL,
  BOOTSTRAP_SINGLETON_MARKER,
  BOOTSTRAP_ORIGINAL,
  BOOTSTRAP_SINGLETON,
  RECONCILE_MISS_ORIGINAL,
  RECONCILE_MISS_NEW,
  applyBootstrapIncludesSingleton,
};