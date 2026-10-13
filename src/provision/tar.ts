// Minimal POSIX ustar writer: regular files only, enough to ship a node's desired state
// over SSH stdin (spec 7.3) without depending on a tar binary on the coordinator.

export interface TarEntry {
  path: string
  mode: number
  content: string | Buffer
}

const BLOCK = 512

function splitPath(path: string): { name: string, prefix: string } {
  if(Buffer.byteLength(path) <= 100) return { name: path, prefix: '' }
  // ustar: name (100) + '/' + prefix (155); split at a '/' so both halves fit.
  for(let i = path.lastIndexOf('/'); i > 0; i = path.lastIndexOf('/', i - 1)) {
    const prefix = path.slice(0, i)
    const name = path.slice(i + 1)
    if(Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100 && name.length > 0) return { name, prefix }
  }
  throw new Error(`tar: path too long for ustar: ${path}`)
}

function writeOctal(buf: Buffer, offset: number, width: number, value: number): void {
  // width-1 octal digits followed by NUL
  const s = value.toString(8).padStart(width - 1, '0')
  if(s.length > width - 1) throw new Error(`tar: value ${value} does not fit in ${width} bytes`)
  buf.write(s, offset, 'ascii')
  buf[offset + width - 1] = 0
}

function header(path: string, mode: number, size: number): Buffer {
  const h = Buffer.alloc(BLOCK)
  const { name, prefix } = splitPath(path)
  h.write(name, 0, 'utf8')
  writeOctal(h, 100, 8, mode & 0o7777)
  writeOctal(h, 108, 8, 0)          // uid
  writeOctal(h, 116, 8, 0)          // gid
  writeOctal(h, 124, 12, size)
  writeOctal(h, 136, 12, 0)         // mtime: fixed so identical input gives identical bytes
  h.write('        ', 148, 'ascii') // checksum placeholder (spaces) while summing
  h.write('0', 156, 'ascii')        // typeflag: regular file
  h.write('ustar\u000000', 257, 'binary')
  h.write('root', 265, 'ascii')
  h.write('root', 297, 'ascii')
  h.write(prefix, 345, 'utf8')

  let sum = 0
  for(const b of h) sum += b
  const chk = sum.toString(8).padStart(6, '0')
  h.write(chk, 148, 'ascii')
  h[154] = 0
  h[155] = 0x20
  return h
}

export function packTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = []
  for(const e of entries) {
    if(!e.path || e.path.startsWith('/') || e.path.split('/').includes('..')) {
      throw new Error(`tar: unsafe entry path: ${e.path}`)
    }
    const data = typeof e.content === 'string' ? Buffer.from(e.content, 'utf8') : e.content
    parts.push(header(e.path, e.mode, data.length), data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if(pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(BLOCK * 2))
  return Buffer.concat(parts)
}
