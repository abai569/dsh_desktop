/**
 * dsh-sidebar-compact — host half (no-op).
 *
 * 侧栏精简完全由浏览器半边（lib/client.js）完成：纯 DOM + CSS，定位内核侧栏的
 * panelList / footArea / 工作区行，做折叠与隐藏。本半边仅为让包成为合法 bundle。
 */
export const name = 'dsh-sidebar-compact';
export const inject = [];
export function apply() {
  // no-op.
}
