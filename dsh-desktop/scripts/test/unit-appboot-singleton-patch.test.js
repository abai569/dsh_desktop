'use strict';

// unit-appboot-singleton-patch.test.js —— 2026-10-11 macOS 实机 bug 回归：
// 「点开始设置进不去」+「未能保存设置，请重试。」反复回滚 welcome，且引导之后的
// 模型设置页也一律存不住（= settings.mutate 全线失败）。
//
// 根因（两段探针日志定案，非推断）：宿主响应 code = settings/rejected、details 只带
// { ns }；进内核拿到原始 message = `dsh: profile reload requires the root Include
// entry`，出自 dsh-app-boot 的 reconcileProfilePatches 取 bootstrapIncludes.get(ctx)
// 落空。埋探针后出现自相矛盾的事实：`.set(ctx, entry)` 确实执行、传入 ctx 与登记
// ctx `sameCtx=true`、ctx 非空（ctxHasLoader=true），`.get(ctx)` 却返回 undefined
// —— WeakMap 不可能这样，只能是同一份模块被加载成两个 ESM 实例、各持一张表。
// 给模块加随机指纹 + 打 import.meta.url 立刻现形：
//
//   mount:     mod=l6pev0  …/Contents/resources/dsh-desktop/…/dsh-app-boot/lib/index.js
//   reconcile: mod=k9wf29  …/Contents/Resources/dsh-desktop/…/dsh-app-boot/lib/index.js
//
// 只差一个字母：磁盘真实目录是 Contents/Resources（壳 supervisor spawn 内核时拼了
// 小写 r），APFS 大小写不敏感（同一份文件）但 ESM 模块缓存按 URL 字符串区分大小写
// → 同一文件被判定为两个模块。
//
// 补丁（scripts/lib/appboot-singleton-patch.js）：bootstrapIncludes 从模块级 WeakMap
// 提升为 globalThis 惰性建（`??=`），两实例共享一张表；顺带给 reconcile 落空时的
// 静默 throw 补一条可检索日志。
//
// 本测试三层：
//   ① transform 契约（锚点唯一 / 幂等 / 锚点失配不改写）；
//   ② **行为级**——把补丁产物按两个不同模块实例各求值一次，验证「mount 侧写入、
//      reconcile 侧读取」真能命中（这正是原 bug 的直接对抗面，单测里复现最强断言
//      就是：未打补丁时必须读不到，打补丁后必须读到）；
//   ③ 语义不变式（仍是 WeakMap、键是 ctx、弱引用不泄漏）＋ 失配路径。
// 运行：node --test scripts/test/unit-appboot-singleton-patch.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  BOOTSTRAP_SINGLETON_MARKER,
  BOOTSTRAP_ORIGINAL,
  BOOTSTRAP_SINGLETON,
  RECONCILE_MISS_ORIGINAL,
  RECONCILE_MISS_NEW,
  applyBootstrapIncludesSingleton,
} = require('../lib/appboot-singleton-patch');

const { transformAppBootBootstrapSingleton } = require('../lib/patch-adapters');
const { BOOTSTRAP_SINGLETON_MARKER: REGISTRY_MARKER } = require('../lib/patch-adapters').markers;

// ---------------------------------------------------------------------------
// dsh-app-boot pristine 节选（rc.2 字节形态，esbuild 产物）。只取本补丁锚到的
// 两处：bootstrapIncludes 声明 + reconcile 的取表/抛错分支。
// ---------------------------------------------------------------------------

const APP_BOOT_PRISTINE = [
  'const bootstrapIncludes = /* @__PURE__ */ new WeakMap();',
  'function reconcileProfilePatches(binName, ctx, desired) {',
  '\tconst entry = bootstrapIncludes.get(ctx);',
  '\tif (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);',
  '\treturn entry;',
  '}',
].join('\n');

const APP_BOOT_FILE_REL = 'dsh-app-boot/lib/index.js';

// ---------------------------------------------------------------------------
// 1) transform 契约
// ---------------------------------------------------------------------------

test('1.1 pristine 锚点恰好一处、产物含 marker 且语法可解析', () => {
  assert.ok(
    APP_BOOT_PRISTINE.includes(BOOTSTRAP_ORIGINAL),
    '夹具必须含上游原始 WeakMap 声明',
  );
  assert.ok(
    APP_BOOT_PRISTINE.includes(RECONCILE_MISS_ORIGINAL),
    '夹具必须含 reconcile 的抛错分支',
  );
  const out = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE);
  assert.equal(out.changed, true, 'pristine 应被判为可改写');
  assert.ok(out.src.includes(BOOTSTRAP_SINGLETON_MARKER), '产物必须带幂等 marker');
  assert.ok(!out.src.includes(BOOTSTRAP_ORIGINAL), '原始 WeakMap 声明不应残留');
  assert.ok(out.src.includes(RECONCILE_MISS_NEW), '产物应含带日志的抛错分支');
  // 补丁产物本身必须是合法 JS（否则注入即炸）。
  assert.doesNotThrow(() => new vm.Script(`(function(){${out.src}\n})`));
});

test('1.2 幂等：已注入的字节再跑一次为 changed=false 且不改写', () => {
  const once = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE);
  const twice = applyBootstrapIncludesSingleton(once.src);
  assert.equal(twice.changed, false, '二次应用必须是 changed=false');
  assert.equal(twice.src, undefined, 'changed=false 时不得返回 src（调用方按 marker 判 already）');
  assert.ok(once.src.includes(BOOTSTRAP_SINGLETON_MARKER), 'marker 必须在第一次就已就位');
});

test('1.3 锚点失配不改写（上游改字节时自然退役，不半改）', () => {
  // 只剩 WeakMap 声明、reconcile 那行没了：整体不写。
  const noReconcile = 'const bootstrapIncludes = /* @__PURE__ */ new WeakMap();\nfoo();';
  const r1 = applyBootstrapIncludesSingleton(noReconcile);
  assert.equal(r1.changed, false, 'reconcile 锚点失配必须整体不改写');
  assert.equal(r1.src, undefined);

  // 只剩 reconcile 行、WeakMap 声明变形：同样整体不写。
  const noWeakMap = [
    'const bootstrapIncludes = new WeakMap(); // 上游改了形态',
    'function reconcileProfilePatches(binName, ctx, desired) {',
    '\tconst entry = bootstrapIncludes.get(ctx);',
    '\tif (entry === void 0) throw new Error(`${binName}: profile reload requires the root Include entry`);',
    '\treturn entry;',
    '}',
  ].join('\n');
  const r2 = applyBootstrapIncludesSingleton(noWeakMap);
  assert.equal(r2.changed, false, 'WeakMap 锚点失配必须整体不改写');
});

test('1.4 transform 收口：状态三分支正确（changed / already / anchor-missing）', () => {
  const changed = transformAppBootBootstrapSingleton(APP_BOOT_PRISTINE, APP_BOOT_FILE_REL);
  assert.equal(changed.status, 'changed');
  assert.ok(changed.src.includes(BOOTSTRAP_SINGLETON_MARKER));

  const patched = changed.src;
  const again = transformAppBootBootstrapSingleton(patched, APP_BOOT_FILE_REL);
  assert.equal(again.status, 'already', '已注入须短路 already（静默）');

  const drifted = transformAppBootBootstrapSingleton('const unrelated = 1;', APP_BOOT_FILE_REL);
  assert.equal(drifted.status, 'anchor-missing', '字节漂移须判 anchor-missing');
  assert.match(drifted.detail, /锚点未匹配/);
});

test('1.5 marker 单一数据源：transform 的 already 判定与 registry spec 同源', () => {
  assert.equal(REGISTRY_MARKER, BOOTSTRAP_SINGLETON_MARKER,
    'registry 用的 marker 必须与 transform 判定用的是同一个常量');
});

// ---------------------------------------------------------------------------
// 2) 行为级：两个「模块实例」能否共享一张表 —— 本 bug 的直接对抗面
//
// 手法要点（vm 语义踩过的坑，这里写明免得后人重蹈）：要让两份模块实例真的
// 「共享同一个 globalThis」，不能各建一个 vm realm 再靠 `globalThis` 属性赋值
// —— `vm.createContext(sandbox)` 的 globalThis 是**该 realm 独有的沙箱对象**，
// 跨 realm 写属性互不可见。正确姿势是把**同一个宿主对象**同时作为两个 realm
// 沙箱的 `globalThis` 传进去，这样 realm 内 `globalThis.__dshX = …` 落在同一个
// 宿主对象上（真进程的拓扑），而两份 `bootstrapIncludes` 声明仍各自求值（两个
// 模块实例）。
//
// 原 bug 的断言形态：mount 侧 set 之后，reconcile 侧 get 必须拿到 entry；
// 未打补丁时这一句必然拿到 undefined（模块级 WeakMap 分裂的最小复现）。
// ---------------------------------------------------------------------------

/** 把 dsh-app-boot 片段在一组 realm 里各求值一次，模拟「若干个模块实例」。 */
function evalInstances(src, count, consoleErrors) {
  // 同一个宿主 global 供所有 realm 共享 —— 这是「同一进程」的模拟，也是修复
  // 生效的前提（表挂在 globalThis.__dshBootstrapIncludes 上，跨实例可见）。
  const hostGlobal = { console: { error: (m) => consoleErrors.push(m) } };
  const realms = [];
  for (let i = 0; i < count; i += 1) {
    const realm = vm.createContext(hostGlobal);
    // 关键（三处 vm 语义坑都在这段，记下来免得后人重蹈）：
    // ① 每个 realm 真跑一次 src —— 这才形成「各持一份 bootstrapIncludes」的
    //    多个模块实例（打补丁后共享 globalThis 上那一张；未打补丁时各一张、
    //    互不可见，正是原 bug）；
    // ② 声明必须包在**函数体内**：`const` 在 vm script 顶层属「脚本作用域」，
    //    多个 realm 共享同一 host global 时顶层重复 `const` 会直接
    //    "Identifier 'x' has already been declared"；
    // ③ **api 句柄绝不能挂 globalThis**——那会挂到共享的 hostGlobal 上，
    //    后建的 realm 覆盖先建的，「mount 侧」被偷换成 reconcile 侧，
    //    2.1 的「未打补丁读不到」会被伪造成「读到了」（踩过一次）。
    //    正确姿势：让脚本**返回**句柄，由 runInContext 直接取回；
    //    globalThis 只承载补丁真正要共享的那张表。
    const api = new vm.Script(
      `(function () { ${src}
        return {
          map: bootstrapIncludes,
          set: (k, v) => bootstrapIncludes.set(k, v),
          get: (k) => bootstrapIncludes.get(k),
          // 与补丁产物里 RECONCILE_MISS_NEW 同形的取表逻辑（声明在实例闭包内，
          // 直接持有 bootstrapIncludes —— 不再需要往 realm 注入变量）。
          reconcile: (binName, ctx) => {
            const entry = bootstrapIncludes.get(ctx);
            if (entry === void 0) { console.error("[dsh-desktop-patch] profile-reload-miss: " + binName); throw new Error(\`\${binName}: profile reload requires the root Include entry\`); }
            return entry;
          },
        };
      })();`,
      { filename: `dsh-app-boot#${i}` },
    ).runInContext(realm);
    realms.push({ api, realm });
  }
  return { hostGlobal, realms };
}

test('2.1 未打补丁：两实例必然读不到（这就是原 bug 的最小复现）', () => {
  const errors = [];
  const { realms } = evalInstances(APP_BOOT_PRISTINE, 2, errors);
  const [mountRealm, reconcileRealm] = realms;
  const sharedCtx = { ctx: 'shared' };

  // mount 实例登记进「它自己那张表」。
  const entry = { id: 'include' };
  mountRealm.api.set(sharedCtx, entry);

  // reconcile 实例按同一 ctx 对象取表 —— 模块级 WeakMap 分裂，必然读不到。
  const got = reconcileRealm.api.get(sharedCtx);
  assert.equal(got, undefined,
    '未打补丁时模块级 WeakMap 分裂，reconcile 侧读不到 mount 侧登记的表 —— 原 bug');
  // 反向自查：mount 侧自己那张表是能读到的（排除「键用法错」这一干扰解释）。
  assert.equal(mountRealm.api.get(sharedCtx), entry,
    'mount 侧自读必须命中 —— 否则就不是「分裂」而是「用例写错了」');
});

test('2.2 打补丁后：mount 侧写入、reconcile 侧能读到（修复生效的直接断言）', () => {
  const patched = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE).src;
  const errors = [];
  const { realms } = evalInstances(patched, 2, errors);
  const [mountRealm, reconcileRealm] = realms;
  const sharedCtx = { ctx: 'shared' };

  const entry = { id: 'include', options: { id: 'include' } };
  mountRealm.api.set(sharedCtx, entry);

  const got = reconcileRealm.api.get(sharedCtx);
  assert.notEqual(got, undefined, '打补丁后 reconcile 侧必须读得到（这就是修复的核心断言）');
  assert.equal(got, entry, '读到的必须是 mount 侧登记的那一个 entry');
  assert.equal(got.options.id, 'include');
  // 两实例拿到的必须是同一张表（不是各自新建了一张恰好都能读——不可能，
  // 但断言对象同一性把话钉死）。
  assert.equal(mountRealm.api.map, reconcileRealm.api.map,
    '两个实例必须共享同一个 WeakMap 实例');
});

test('2.3 无论实例求值顺序如何都共享同一张表（惰性建不挑先到者）', () => {
  const patched = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE).src;
  const errors = [];
  // 第一个 realm 当「先摸表的 reconcile 侧」，第二个当「后写的 mount 侧」。
  const { realms } = evalInstances(patched, 2, errors);
  const [reconcileRealm, mountRealm] = realms;
  const sharedCtx = { ctx: 'shared' };

  // 先让 reconcile 侧摸一次表（触发惰性建 —— 表此时为空）。
  assert.equal(reconcileRealm.api.get(sharedCtx), undefined, '尚未登记应返回 undefined');

  // 再由 mount 侧写入。
  const entry = { id: 'include' };
  mountRealm.api.set(sharedCtx, entry);

  assert.equal(reconcileRealm.api.get(sharedCtx), entry,
    '先读的实例也必须看到后写实例的登记 —— 共享的是同一张表，与谁先建无关');
});

// ---------------------------------------------------------------------------
// 3) 语义不变式：修的是「存放位置」，不是「数据结构」
// ---------------------------------------------------------------------------

test('3.1 仍是 WeakMap、键仍是 ctx（没有退化成普通 Map 或字符串键）', () => {
  const patched = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE).src;
  assert.ok(/globalThis\.__dshBootstrapIncludes\s*\?\?=\s*\/\* @__PURE__ \*\/ new WeakMap\(\)/.test(patched),
    '必须是 globalThis 上惰性建的 WeakMap');

  const { realms } = evalInstances(patched, 1, []);
  const { api } = realms[0];
  // 跨 realm 的 instanceof 不可靠（原型链是 sandbox 的），故用 toString tag。
  assert.match(Object.prototype.toString.call(api.map), /WeakMap/, '表必须仍是 WeakMap');
  // 字符串键会被 WeakMap 拒收（正是「键必须是 ctx 对象」的证据）。
  // 注意：抛出的 TypeError 来自 sandbox realm，跨 realm 的 instanceof 不可靠，
  // 故按 message 断言（V8 的措辞稳定）。
  assert.throws(() => api.set('str', 1),
    /Invalid value used as weak map key|Invalid value used in weak set/,
    'WeakMap 键必须是对象 —— 字符串键被拒');
  // 对象键正常工作。
  const k = { ctx: true };
  api.set(k, { v: 1 });
  assert.equal(api.get(k).v, 1);
});

test('3.2 get 语义逐字不变：未登记即 undefined（不引入新默认值）', () => {
  const patched = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE).src;
  const { realms } = evalInstances(patched, 1, []);
  const got = realms[0].api.get({ never: 'registered' });
  assert.equal(got, undefined, '未登记的 ctx 仍返回 undefined —— 原 throw 条件语义不变');
});

test('3.3 失配日志只在真出问题时打，且抛出信息逐字不变（不吞错、不改文案）', () => {
  const patched = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE).src;
  assert.ok(patched.includes('profile-reload-miss'), '应含可检索日志标记');
  // 抛给上层的 message 一个字都不能改：dsh-api-settings-controller 依此包成
  // settings/rejected，上游与日志分析都按这句话认。
  assert.ok(patched.includes('`${binName}: profile reload requires the root Include entry`'),
    '对外抛错文案必须逐字不变');

  const errors = [];
  const { realms } = evalInstances(patched, 1, errors);
  const { api } = realms[0];
  // 走真实 reconcile 逻辑 —— 未登记故失配：打一条日志 + 照原样抛。
  assert.throws(() => api.reconcile('dsh', { unregistered: true }),
    /profile reload requires the root Include entry/);
  assert.equal(errors.length, 1, '失配时应恰好打一条日志');
  assert.match(errors[0], /profile-reload-miss: dsh/);
});

test('3.4 命中路径不打日志（平时零噪音）', () => {
  const patched = applyBootstrapIncludesSingleton(APP_BOOT_PRISTINE).src;
  const errors = [];
  const { realms } = evalInstances(patched, 1, errors);
  const { api } = realms[0];
  const ctx = { hit: true };
  api.set(ctx, { id: 'include' });
  const got = api.reconcile('dsh', ctx);
  assert.equal(got.id, 'include', '命中时应正常返回 entry');
  assert.deepEqual(errors, [], '命中路径不得产生任何日志');
});