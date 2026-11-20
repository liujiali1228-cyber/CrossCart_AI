/**
 * 场景图的「网页版」变体：把生成原图（1024×1536 PNG，约 3MB）压成 ~180KB 的 WebP。
 *
 * 为什么需要：原图只适合存档与热点识别，不适合直接当页面图。
 * 本机看没问题，一旦走公网隧道（带宽被限）就会出现「图一直在加载、舞台空着」，
 * 体验者会以为功能坏了。压一份小图给页面用，原图仍然保留（热点、下载、复检都用它）。
 *
 * 设计原则：
 *   - 可选依赖：没装 sharp 或压缩失败时返回 null，页面自动回退到原图，功能不因此不可用；
 *   - 只做等比缩小，不裁切（热点坐标基于原图比例，裁切会让点击位置整体错位）；
 *   - 幂等：目标文件比原图新就跳过，重复调用不重复压缩。
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const WEB_WIDTH = 900
export const WEB_QUALITY = 80

/** 原图 → 网页版路径（不检查是否存在）。 */
export function webPathFor(dir, file) {
  return join(dir, String(file).replace(/\.png$/i, '.webp'))
}

/** 网页版是否已可用（存在且不比原图旧）。 */
export function hasWebVariant(dir, file) {
  const src = join(dir, file)
  const dst = webPathFor(dir, file)
  if (!existsSync(src) || !existsSync(dst)) return false
  try {
    return statSync(dst).mtimeMs >= statSync(src).mtimeMs
  } catch {
    return false
  }
}

/**
 * 生成（或复用）网页版。
 * @returns {Promise<string|null>} 生成成功返回文件路径，失败返回 null（调用方应回退原图）
 */
export async function ensureWebVariant(dir, file, { width = WEB_WIDTH, quality = WEB_QUALITY } = {}) {
  const src = join(dir, file)
  if (!existsSync(src)) return null
  if (hasWebVariant(dir, file)) return webPathFor(dir, file)
  const dst = webPathFor(dir, file)
  try {
    const sharp = (await import('sharp')).default
    await sharp(src)
      .resize({ width, withoutEnlargement: true, fit: 'inside' })
      .webp({ quality })
      .toFile(dst)
    return dst
  } catch {
    return null
  }
}
