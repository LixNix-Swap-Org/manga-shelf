import fs from 'fs'
import path from 'path'
import zlib from 'zlib'

const PRECOMPRESS_EXT = /\.(js|css|svg|json|html|txt|webmanifest)$/

// .br (q11) and .gz (level 9) next to every compressible build asset over 1 KB, so the server can send them
// without compressing on each request; a variant is only written when it is smaller than the original
export function precompressDir(dir, { minBytes = 1024 } = {}) {
  const written = []
  if (!fs.existsSync(dir)) return written
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      written.push(...precompressDir(file, { minBytes }))
      continue
    }
    if (!PRECOMPRESS_EXT.test(entry.name)) continue
    const raw = fs.readFileSync(file)
    if (raw.length < minBytes) continue
    const br = zlib.brotliCompressSync(raw, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
      }
    })
    const gz = zlib.gzipSync(raw, { level: 9 })
    if (br.length < raw.length) { fs.writeFileSync(`${file}.br`, br); written.push(`${file}.br`) }
    if (gz.length < raw.length) { fs.writeFileSync(`${file}.gz`, gz); written.push(`${file}.gz`) }
  }
  return written
}
