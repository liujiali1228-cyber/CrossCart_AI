// 最小静态服务器：仅供本地原型预览（loopback）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (url === '/') url = '/demo/index.html'
    const file = normalize(join(root, url))
    if (!file.startsWith(root)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

const port = Number(process.env.PORT ?? 8787)
server.listen(port, '127.0.0.1', () => {
  console.log(`crosscart demo → http://127.0.0.1:${port}`)
})
