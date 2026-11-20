// 构建期生成商品图：白底原图（main，详情页用）+ 透明底图（cutout，拼搭画布用）。
// 真实项目里这一步对应「API 取图 → 授权校验 → 抠图（rembg/云API）→ 落盘」。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const seedPath = join(root, 'data', 'seed', 'catalog.json')
const mainDir = join(root, 'data', 'seed', 'assets', 'main')
const cutDir = join(root, 'data', 'seed', 'assets', 'cutout')
mkdirSync(mainDir, { recursive: true })
mkdirSync(cutDir, { recursive: true })

const COLORS = {
  ivory: '#EDE6D6', black: '#2E2E30', beige: '#D9C9A8', denim: '#6B84A8',
  cream: '#F0EADA', 'sky-blue': '#B9D2E8', charcoal: '#4A4A4C',
  natural: '#C9BFA8', sand: '#E3D6BC', tan: '#A8846B', indigo: '#3A4A63',
  white: '#F4F4F0',
}
const INK = '#2C2C2A'

function shapeOf(productId, category) {
  if (productId === 'ow_denim_jacket') return jacket
  if (category === 'outerwear') return trench
  if (productId === 'top_sky_shirt') return shirt
  if (productId === 'top_black_turtleneck') return knit
  if (category === 'top') return tee
  if (productId === 'own_dark_jeans') return jeans
  if (category === 'bottom') return trousers
  if (productId === 'shoe_white_sneaker') return sneaker
  if (productId === 'shoe_beige_slipon') return slipon
  if (category === 'shoes') return loafer
  if (productId === 'bag_canvas_tote') return tote
  if (productId === 'bag_drawstring') return drawstring
  return crossbody
}

const detail = (d) => `<path d="${d}" fill="none" stroke="${INK}" stroke-width="3.5" opacity="0.4" stroke-linecap="round"/>`

function trench(fill) {
  return { vb: '76 56 248 292', body: `
  <path d="M138 100 L96 118 L84 232 L116 236 L128 128" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M262 100 L304 118 L316 232 L284 236 L272 128" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M144 78 L256 78 L270 336 L130 336 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M144 78 L200 148 L256 78" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M162 92 L200 148 L238 92')}
  <rect x="130" y="186" width="140" height="16" rx="6" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  <rect x="188" y="182" width="24" height="24" rx="4" fill="none" stroke="${INK}" stroke-width="4"/>
  <circle cx="200" cy="162" r="5" fill="${INK}" opacity="0.75"/>
  <circle cx="200" cy="226" r="5" fill="${INK}" opacity="0.75"/>
  <circle cx="200" cy="266" r="5" fill="${INK}" opacity="0.75"/>` }
}

function jacket(fill) {
  return { vb: '84 74 232 226', body: `
  <path d="M142 100 L104 120 L92 228 L122 232 L134 128" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M258 100 L296 120 L308 228 L278 232 L266 128" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M146 84 L254 84 L262 288 L138 288 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M146 84 L200 140 L254 84" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M150 150 H186 M214 150 H250')}
  ${detail('M152 158 V196 M248 158 V196')}
  <circle cx="200" cy="168" r="5" fill="${INK}" opacity="0.75"/>
  <circle cx="200" cy="210" r="5" fill="${INK}" opacity="0.75"/>` }
}

function tee(fill) {
  return { vb: '96 82 208 230', body: `
  <path d="M150 92 L104 140 L126 166 L152 132" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M250 92 L296 140 L274 166 L248 132" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M150 92 C168 116 232 116 250 92 L252 300 L148 300 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M162 92 C176 130 224 130 238 92" fill="none" stroke="${INK}" stroke-width="5"/>` }
}

function shirt(fill) {
  return { vb: '98 86 204 234', body: `
  <path d="M150 96 L106 148 L128 174 L152 138" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M250 96 L294 148 L272 174 L248 138" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M150 96 L252 96 L254 310 L148 310 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M150 96 L200 132 L250 96" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M200 134 V306')}
  <circle cx="200" cy="176" r="4" fill="${INK}" opacity="0.7"/>
  <circle cx="200" cy="216" r="4" fill="${INK}" opacity="0.7"/>
  <circle cx="200" cy="256" r="4" fill="${INK}" opacity="0.7"/>` }
}

function knit(fill) {
  return { vb: '96 54 208 270', body: `
  <rect x="168" y="64" width="64" height="34" rx="10" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  <path d="M150 98 L104 150 L126 176 L152 140" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M250 98 L296 150 L274 176 L248 140" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M150 98 L250 98 L252 312 L148 312 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M158 140 H242 M158 180 H242 M158 220 H242')}` }
}

function trousers(fill) {
  return { vb: '132 58 136 290', body: `
  <rect x="140" y="66" width="120" height="26" rx="5" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  <path d="M146 92 L196 92 L188 336 L150 336 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M204 92 L254 92 L250 336 L212 336 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M200 92 V150')}` }
}

function jeans(fill) {
  return { vb: '132 58 136 290', body: `
  <rect x="140" y="66" width="120" height="26" rx="5" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  <path d="M146 92 L196 92 L188 336 L150 336 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <path d="M204 92 L254 92 L250 336 L212 336 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M200 92 V160')}
  ${detail('M152 96 C166 118 182 118 190 98')}
  ${detail('M210 96 C224 118 240 118 248 98')}` }
}

function sneaker(fill) {
  return { vb: '40 160 324 152', body: `
  <path d="M74 250 C80 208 106 186 142 182 C178 178 198 198 228 210 C264 224 302 230 344 250 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <rect x="48" y="250" width="304" height="44" rx="22" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  <path d="M74 250 C76 226 80 210 88 196" fill="none" stroke="${INK}" stroke-width="4" opacity="0.5"/>
  ${detail('M152 196 L188 214 M178 190 L214 208 M204 186 L240 204')}
  ${detail('M284 250 C300 232 326 228 344 250')}
  ${detail('M96 268 L330 268')}
` }
}

function slipon(fill) {
  return { vb: '44 168 316 126', body: `
  <path d="M70 250 C90 196 214 178 262 204 C306 227 334 240 350 250 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <rect x="52" y="250" width="300" height="36" rx="18" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  ${detail('M118 236 C160 208 226 208 262 236')}` }
}

function loafer(fill) {
  return { vb: '52 158 312 128', body: `
  <path d="M78 246 C98 190 224 168 280 200 C318 221 340 236 354 246 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  <rect x="60" y="246" width="296" height="30" rx="15" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  ${detail('M170 226 C210 210 258 212 292 228')}
  ${detail('M150 246 C186 232 236 232 268 246')}` }
}

function tote(fill) {
  return { vb: '96 84 208 262', body: `
  <path d="M152 172 C152 92 248 92 248 172" fill="none" stroke="${INK}" stroke-width="10" stroke-linecap="round"/>
  <path d="M122 172 L278 172 L296 336 L104 336 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M132 200 L268 200')}` }
}

function drawstring(fill) {
  return { vb: '118 78 164 254', body: `
  <path d="M160 120 C160 88 240 88 240 120" fill="none" stroke="${INK}" stroke-width="6" stroke-linecap="round"/>
  <path d="M136 124 L264 124 L272 320 L128 320 Z" fill="${fill}" stroke="${INK}" stroke-width="5" stroke-linejoin="round"/>
  ${detail('M136 150 C176 166 224 166 264 150')}
  ${detail('M160 200 C180 260 220 260 240 200')}` }
}

function crossbody(fill) {
  return { vb: '84 54 232 258', body: `
  <path d="M96 96 C96 64 304 64 304 96" fill="none" stroke="${INK}" stroke-width="7" stroke-linecap="round"/>
  <rect x="132" y="172" width="136" height="130" rx="18" fill="${fill}" stroke="${INK}" stroke-width="5"/>
  <path d="M132 190 C176 150 224 150 268 190" fill="none" stroke="${INK}" stroke-width="4" opacity="0.5"/>
  <rect x="176" y="228" width="48" height="12" rx="6" fill="${INK}" opacity="0.6"/>` }
}

function svg(inner, withBg, vb) {
  const [x, y, w, h] = vb.split(' ')
  const bg = withBg ? `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>` : ''
  // width/height 跟随 viewBox 比例，避免 SVG 被当成正方形而留出大片空白
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${w}" height="${h}">${bg}${inner}</svg>`
}

const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
let n = 0
for (const item of [...seed.items, ...seed.owned]) {
  const fill = COLORS[item.color] ?? '#CCCCCC'
  const { vb, body } = shapeOf(item.productId, item.category)(fill)
  writeFileSync(join(mainDir, `${item.productId}.svg`), svg(body, true, vb))
  writeFileSync(join(cutDir, `${item.productId}.svg`), svg(body, false, vb))
  n += 2
}
console.log(`generated ${n} assets (${n / 2} items: main + cutout)`)
