/**
 * 最小 PNG 解码器（只做我们真正需要的事）。
 *
 * 为什么自己写：热点识别必须在服务端读像素，而项目刻意不引入图像处理依赖。
 * 我们只支持自己生成/抓取得到的常见格式：8bit、非隔行、colorType 2(RGB) / 6(RGBA) /
 * 0(灰度) / 4(灰度+alpha) / 3(调色板)。遇到别的格式**明确报错**，绝不返回一张错图当结果。
 */
import { inflateSync } from 'node:zlib'

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** @returns {{width:number,height:number,data:Uint8Array}} data 为 RGBA，长度 = w*h*4 */
export function decodePng(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 33) throw new Error('不是 PNG：内容太短')
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('不是 PNG：签名不匹配')

  let pos = 8
  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 0
  let interlace = 0
  let palette = null
  let trns = null
  const idat = []

  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    const body = buf.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8]
      colorType = body[9]
      interlace = body[12]
    } else if (type === 'PLTE') palette = Buffer.from(body)
    else if (type === 'tRNS') trns = Buffer.from(body)
    else if (type === 'IDAT') idat.push(body)
    else if (type === 'IEND') break
  }

  if (!width || !height) throw new Error('PNG 缺少 IHDR')
  if (interlace !== 0) throw new Error('暂不支持隔行扫描（interlaced）PNG')
  if (bitDepth !== 8) throw new Error(`暂不支持 ${bitDepth}bit PNG（只支持 8bit）`)
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error(`暂不支持 PNG colorType=${colorType}`)
  if (idat.length === 0) throw new Error('PNG 没有 IDAT')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = new Uint8Array(width * height * 4)
  let prev = Buffer.alloc(stride)
  let p = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[p++]
    const line = Buffer.from(raw.subarray(p, p + stride))
    p += stride
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? line[i - channels] : 0
      const b = prev[i]
      const c = i >= channels ? prev[i - channels] : 0
      switch (filter) {
        case 0: break
        case 1: line[i] = (line[i] + a) & 0xff; break
        case 2: line[i] = (line[i] + b) & 0xff; break
        case 3: line[i] = (line[i] + ((a + b) >> 1)) & 0xff; break
        case 4: line[i] = (line[i] + paeth(a, b, c)) & 0xff; break
        default: throw new Error(`PNG 行过滤器非法：${filter}`)
      }
    }
    prev = line
    const o = y * width * 4
    for (let x = 0; x < width; x++) {
      const si = x * channels
      const di = o + x * 4
      if (colorType === 2) {
        out[di] = line[si]; out[di + 1] = line[si + 1]; out[di + 2] = line[si + 2]; out[di + 3] = 255
      } else if (colorType === 6) {
        out[di] = line[si]; out[di + 1] = line[si + 1]; out[di + 2] = line[si + 2]; out[di + 3] = line[si + 3]
      } else if (colorType === 0) {
        const g = line[si]
        out[di] = g; out[di + 1] = g; out[di + 2] = g; out[di + 3] = 255
      } else if (colorType === 4) {
        const g = line[si]
        out[di] = g; out[di + 1] = g; out[di + 2] = g; out[di + 3] = line[si + 1]
      } else {
        const idx = line[si]
        if (!palette) throw new Error('调色板 PNG 缺少 PLTE')
        out[di] = palette[idx * 3] ?? 0
        out[di + 1] = palette[idx * 3 + 1] ?? 0
        out[di + 2] = palette[idx * 3 + 2] ?? 0
        out[di + 3] = trns && idx < trns.length ? trns[idx] : 255
      }
    }
  }
  return { width, height, data: out }
}

/** 等距采样缩小（分析用，不需要高质量缩放；保留 alpha）。 */
export function downscale(img, maxW = 256) {
  const { width, height, data } = img
  if (width <= maxW) return img
  const scale = maxW / width
  const w = Math.max(1, Math.round(width * scale))
  const h = Math.max(1, Math.round(height * scale))
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(height - 1, Math.floor(y / scale))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(width - 1, Math.floor(x / scale))
      const si = (sy * width + sx) * 4
      const di = (y * w + x) * 4
      out[di] = data[si]; out[di + 1] = data[si + 1]; out[di + 2] = data[si + 2]; out[di + 3] = data[si + 3]
    }
  }
  return { width: w, height: h, data: out }
}
