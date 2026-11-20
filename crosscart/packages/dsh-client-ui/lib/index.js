/**
 * 宿主侧空插件：让 Loader 有一个可挂载的入口，
 * 真正的界面在同一包的 ./client 面（由 client-modules 注入浏览器）。
 */
export const name = 'crosscart-client-ui-host'

export function apply() {
  // 不需要宿主能力：卡片只读 tool/result 里的 presentationMeta
}
