// 独立解析 asar 并按 header 内的 SHA256 integrity 校验每个提取文件（结果不可信即报错）
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
const asar = '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
const out = process.argv[2]
const pathRe = new RegExp(process.argv[3])
const fd = fs.openSync(asar, 'r')
const head = Buffer.alloc(16); fs.readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const hb = Buffer.alloc(headerSize); fs.readSync(fd, hb, 0, headerSize, 16)
const header = JSON.parse(hb.toString('utf8'))
// 关键：数据区起点 = 16 + headerSize 之后按 4 字节对齐
const align4 = (n) => (n + 3) & ~3
const base = 16 + align4(headerSize)
console.error('[asar] headerSize=%d pureBase=%d alignedBase=%d fileSize=%d', headerSize, 16 + headerSize, base, fs.fstatSync(fd).size)
const entries = []
const walk = (node, prefix) => {
  for (const [k, v] of Object.entries(node.files ?? {})) {
    const np = prefix + '/' + k
    if (v.files) walk(v, np)
    else entries.push([np, v])
  }
}
walk(header, '')
let n = 0, ok = 0, bad = []
for (const [p, meta] of entries) {
  if (!pathRe.test(p)) continue
  if (meta.unpacked || !Number.isFinite(meta.size)) continue
  const target = path.join(out, p)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const buf = Buffer.alloc(meta.size)
  fs.readSync(fd, buf, 0, meta.size, base + Number(meta.offset))
  fs.writeFileSync(target, buf)
  n++
  const want = meta.integrity?.hash
  if (want) {
    const got = crypto.createHash('sha256').update(buf).digest('hex')
    if (got === want) ok++; else bad.push([p, want, got])
  }
}
console.log(`extracted=${n} integrity_ok=${ok} integrity_bad=${bad.length}`)
for (const [p, w, g] of bad.slice(0, 10)) console.log(`BAD ${p}\n  want=${w}\n  got =${g}`)
process.exitCode = bad.length ? 1 : 0
