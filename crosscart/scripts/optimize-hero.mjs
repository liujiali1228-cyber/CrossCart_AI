/**
 * 首页主视觉的响应式变体（一次性生成，产物直接进仓库）。
 *
 * 为什么要有这一步：主视觉是首屏唯一的阻塞大图。原图 236KB / 200KB 的 JPEG 在宽带上
 * 还行，但移动端 390px 下依然要下整张 1600px 宽的图 —— 公网实测首屏 90 秒都没加载完的那次
 * 就是这类问题叠出来的。这里按用途出 WebP 多档，HTML 用 srcset 让浏览器自己挑。
 *
 * 只做等比缩放与转码，不裁切、不锐化、不调色 —— 视觉风格冻结，不能被「优化」改掉。
 *   node scripts/optimize-hero.mjs
 */
import { statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIR = join(ROOT, 'studio', 'assets')

const JOBS = [
  { src: 'hero-editorial.jpg', out: ['hero-editorial-1600.webp', 1600, 78], also: ['hero-editorial-1000.webp', 1000, 76] },
  { src: 'hero-mobile.jpg', out: ['hero-mobile-780.webp', 780, 78], also: ['hero-mobile-1080.webp', 1080, 78] },
]

for (const job of JOBS) {
  const src = join(DIR, job.src)
  const meta = await sharp(src).metadata()
  console.log(`${job.src}: ${meta.width}×${meta.height} ${(statSync(src).size / 1024).toFixed(0)}KB`)
  for (const spec of [job.out, job.also]) {
    const [name, width, quality] = spec
    const dst = join(DIR, name)
    await sharp(src)
      .resize({ width, withoutEnlargement: true, fit: 'inside' })
      .webp({ quality, effort: 5 })
      .toFile(dst)
    const out = await sharp(dst).metadata()
    console.log(`  → ${name}: ${out.width}×${out.height} ${(statSync(dst).size / 1024).toFixed(0)}KB`)
  }
}
