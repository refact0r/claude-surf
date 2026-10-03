#!/usr/bin/env node
// The frame source of the subway-surfer mod. It runs a game (a page in a
// private Chrome, driven over the DevTools protocol) or a video (ffmpeg), turns
// every frame into a grid of terminal cells (a glyph, a foreground, a
// background) and prints one line per frame on stdout:
//
//   S <json>                      a status: { sock } first, then { phase, message, fps }
//   F <cols> <rows> <base64>      a frame, encoded as a Raster's `cells` are
//   V <cols> <rows> <svg>         a frame as one SVG document (--format svg)
//
// It takes keys, taps and resizes over HTTP on the Unix socket it names in its
// first status line, and ends with its parent: on a signal, a closed stdout,
// or POST /quit. Nothing of it outlives the pane that started it.

import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const MAX_PAIRS = 1024 // the color pairs a Raster paints exactly
const MAX_SVG = 131072 // the characters an Svg's source may hold
const SUPERSAMPLE = 2 // source pixels asked per subpixel, each way

// ---------------------------------------------------------------- arguments

const args = { cols: 60, rows: 40, style: 'ascii', look: 'ascii', format: 'cells', detail: 1 }
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i].replace(/^--/, '')
  const value = process.argv[i + 1]
  if (value === undefined || value.startsWith('--')) args[name] = true
  else { args[name] = value; i++ }
}
for (const key of ['cols', 'rows', 'detail']) args[key] = Math.max(1, Math.round(Number(args[key])))
if (process.env.SURF_MUTE === '1') args.mute = true

// ---------------------------------------------------------------- output

let isBlocked = false
let isEnding = false

const write = line => {
  if (isEnding) return
  isBlocked = !process.stdout.write(line + '\n')
}
const status = fields => write('S ' + JSON.stringify(fields))

process.stdout.on('drain', () => { isBlocked = false })
process.stdout.on('error', () => end(0))

// ---------------------------------------------------------------- glyphs

// A glyph is a code point and its ink coverage over the cell's 2x4 subpixels,
// index row * 2 + column, 0 for none and 1 for full.
const bitsToCoverage = (bits, ink = 1) => Array.from({ length: 8 }, (_, i) => ((bits >> i) & 1) * ink)
const UL = 0b00000101, UR = 0b00001010, LL = 0b01010000, LR = 0b10100000

const GLYPHS = {
  ascii: () => JSON.parse(readFileSync(join(HERE, 'menlo-coverage.json'), 'utf8'))
    .map(([cp, ...percent]) => ({ cp, coverage: percent.map(p => p / 100) })),
  blocks: () => [
    [0x20, 0], [0x2588, 0xff], [0x2580, UL | UR], [0x2584, LL | LR], [0x258c, UL | LL], [0x2590, UR | LR],
    [0x2598, UL], [0x259d, UR], [0x2596, LL], [0x2597, LR], [0x259a, UL | LR], [0x259e, UR | LL],
    [0x259b, UL | UR | LL], [0x259c, UL | UR | LR], [0x2599, UL | LL | LR], [0x259f, UR | LL | LR],
    [0x2582, 0b11000000], [0x2586, 0b11111100],
  ].map(([cp, bits]) => ({ cp, coverage: bitsToCoverage(bits) })),
  // Braille dots 1-8 sit at (column, row) 00 01 02 10 11 12 03 13; a dot inks
  // well under half of its subpixel.
  braille: () => Array.from({ length: 256 }, (_, dots) => {
    const order = [0, 2, 4, 1, 3, 5, 6, 7]
    let bits = 0
    for (let dot = 0; dot < 8; dot++) if ((dots >> dot) & 1) bits |= 1 << order[dot]
    return { cp: dots === 0 ? 0x20 : 0x2800 + dots, coverage: bitsToCoverage(bits, 0.45) }
  }),
}

// The best fit of `a + (b - a) * coverage` to eight values, both levels kept
// within [lo, hi]: the background and foreground that make this glyph look
// most like those subpixels, and how far off it stays.
const fit = (glyph, values, lo, hi) => {
  const c = glyph.coverage
  let mean = 0
  for (let i = 0; i < 8; i++) mean += values[i]
  mean /= 8
  if (glyph.variance < 1e-6) {
    let error = 0
    for (let i = 0; i < 8; i++) error += (mean - values[i]) ** 2
    // A glyph with flat coverage paints one color: the mean, as a mix of two.
    return { a: mean, b: mean, error }
  }
  let slope = 0
  for (let i = 0; i < 8; i++) slope += (c[i] - glyph.mean) * (values[i] - mean)
  slope /= glyph.variance
  let a = mean - slope * glyph.mean
  let b = a + slope
  if (b > hi || b < lo) {
    b = Math.min(hi, Math.max(lo, b))
    let sum = 0
    for (let i = 0; i < 8; i++) sum += (1 - c[i]) * (values[i] - b * c[i])
    a = sum / glyph.sumInverseSquared
  }
  if (a > hi || a < lo) {
    a = Math.min(hi, Math.max(lo, a))
    let sum = 0
    for (let i = 0; i < 8; i++) sum += c[i] * (values[i] - a * (1 - c[i]))
    b = Math.min(hi, Math.max(lo, sum / glyph.sumSquared))
  }
  let error = 0
  for (let i = 0; i < 8; i++) error += (a + (b - a) * c[i] - values[i]) ** 2
  return { a, b, error }
}

// Per style: its glyphs, and for each of the 256 bright/dark patterns of a
// cell the glyph that draws it best.
const styles = new Map()
const styleOf = name => {
  const known = styles.get(name)
  if (known) return known
  const glyphs = (GLYPHS[name] ?? GLYPHS.ascii)()
  for (const glyph of glyphs) {
    const c = glyph.coverage
    glyph.mean = c.reduce((sum, v) => sum + v, 0) / 8
    glyph.variance = c.reduce((sum, v) => sum + (v - glyph.mean) ** 2, 0)
    glyph.sumSquared = c.reduce((sum, v) => sum + v * v, 0) || 1
    glyph.sumInverseSquared = c.reduce((sum, v) => sum + (1 - v) ** 2, 0) || 1
  }
  const byPattern = new Array(256)
  for (let pattern = 0; pattern < 256; pattern++) {
    const target = bitsToCoverage(pattern)
    let best = glyphs[0], least = Infinity
    for (const glyph of glyphs) {
      const { error } = fit(glyph, target, 0, 1)
      if (error < least - 1e-9) { least = error; best = glyph }
    }
    byPattern[pattern] = best
  }
  const style = { glyphs, byPattern }
  styles.set(name, style)
  return style
}

// ---------------------------------------------------------------- the grid

let grid = null

const makeGrid = (cols, rows) => {
  const count = cols * rows
  return {
    cols, rows, count,
    width: cols * 2, height: rows * 4,
    pixels: new Uint8Array(cols * 2 * rows * 4 * 3),
    codePoints: new Uint32Array(count),
    colors: new Uint8Array(count * 6), // fg r g b, bg r g b
    words: new Uint32Array(count * 3),
    order: new Uint32Array(count),
  }
}

// Scales the crop of a source picture into the grid's subpixels, its aspect
// kept and the rest left black: each subpixel is the mean of the source
// pixels it covers.
const resample = (source, sourceWidth, bytesPerPixel, crop, target = grid) => {
  const { width, height, pixels } = target
  const scale = Math.min(width / crop.w, height / crop.h)
  const drawnWidth = Math.max(1, Math.min(width, Math.round(crop.w * scale)))
  const drawnHeight = Math.max(1, Math.min(height, Math.round(crop.h * scale)))
  const left = (width - drawnWidth) >> 1
  const top = (height - drawnHeight) >> 1
  pixels.fill(0)
  const starts = new Int32Array(drawnWidth + 1)
  for (let x = 0; x <= drawnWidth; x++) starts[x] = crop.x + Math.floor((x * crop.w) / drawnWidth)
  for (let y = 0; y < drawnHeight; y++) {
    const y0 = crop.y + Math.floor((y * crop.h) / drawnHeight)
    const y1 = Math.max(y0 + 1, crop.y + Math.floor(((y + 1) * crop.h) / drawnHeight))
    let out = ((top + y) * width + left) * 3
    for (let x = 0; x < drawnWidth; x++) {
      const x0 = starts[x]
      const x1 = Math.max(x0 + 1, starts[x + 1])
      let r = 0, g = 0, b = 0
      for (let sy = y0; sy < y1; sy++) {
        let at = (sy * sourceWidth + x0) * bytesPerPixel
        for (let sx = x0; sx < x1; sx++, at += bytesPerPixel) {
          r += source[at]; g += source[at + 1]; b += source[at + 2]
        }
      }
      const n = (x1 - x0) * (y1 - y0)
      pixels[out++] = r / n; pixels[out++] = g / n; pixels[out++] = b / n
    }
  }
}

const FLAT = 10 // a cell whose luminance spans less is one color
const TEXTURE = 28 // in the ascii look, a cell spanning less is drawn from the ramp
const SPREAD = 0.8 // how far the ramp's two colors part around the cell's own
// `full` is no glyphs at all: the frame itself, at the picture's size.
const LOOKS = ['ascii', 'classic', 'smooth', 'full']
const channel = new Float64Array(8)
const luminance = new Float64Array(8)
const mean = new Float64Array(3)

// The glyphs of a brightness ramp, sparsest ink first.
const RAMP = ` .'-:;=+*xo%#@`
const rampOf = style => {
  style.ramp ??= [...RAMP].map(ch => style.glyphs.find(glyph => glyph.cp === ch.charCodeAt(0)))
    .filter(Boolean).sort((p, q) => p.mean - q.mean)
  return style.ramp
}

// Picks each cell's glyph and its two colors. The smooth look draws each cell
// as faithfully as a glyph can: the glyph whose shape fits its bright/dark
// pattern, in the two colors that best reproduce it. Small glyphs then fade
// into the picture, so the ascii look gives every flat cell a glyph from the
// brightness ramp, its colors parted around the cell's own so the mean stays
// true; the classic look draws only ramp glyphs, vivid on near black.
const pickCells = (style, look) => {
  const { cols, rows, width, pixels, codePoints, colors } = grid
  const ramp = style === styles.get('ascii') && look !== 'smooth' ? rampOf(style) : null
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col
      const base = (row * 4 * width + col * 2) * 3
      let darkest = 255, brightest = 0
      mean.fill(0)
      for (let i = 0; i < 8; i++) {
        const at = base + ((i >> 1) * width + (i & 1)) * 3
        const l = (pixels[at] * 77 + pixels[at + 1] * 150 + pixels[at + 2] * 29) / 256
        luminance[i] = l
        if (l < darkest) darkest = l
        if (l > brightest) brightest = l
        mean[0] += pixels[at] / 8; mean[1] += pixels[at + 1] / 8; mean[2] += pixels[at + 2] / 8
      }
      if (ramp && (look === 'classic' || brightest - darkest < TEXTURE)) {
        const light = (mean[0] * 77 + mean[1] * 150 + mean[2] * 29) / 256
        const glyph = ramp[Math.min(ramp.length - 1, Math.floor((light / 256) * ramp.length))]
        codePoints[cell] = glyph.cp
        const lift = look === 'classic' ? Math.min(3, 255 / Math.max(1, mean[0], mean[1], mean[2])) : 1 + SPREAD * (1 - glyph.mean)
        const sink = look === 'classic' ? 0.12 : 1 - SPREAD * glyph.mean
        for (let k = 0; k < 3; k++) {
          colors[cell * 6 + k] = Math.min(255, Math.round(mean[k] * lift))
          colors[cell * 6 + 3 + k] = Math.round(mean[k] * sink)
        }
        if (glyph.cp === 0x20) for (let k = 0; k < 3; k++) colors[cell * 6 + k] = colors[cell * 6 + 3 + k]
        continue
      }
      const isFlat = brightest - darkest < FLAT
      let pattern = 0
      if (!isFlat) {
        const middle = (darkest + brightest) / 2
        for (let i = 0; i < 8; i++) if (luminance[i] > middle) pattern |= 1 << i
      }
      const glyph = style.byPattern[pattern]
      codePoints[cell] = glyph.cp
      for (let k = 0; k < 3; k++) {
        for (let i = 0; i < 8; i++) channel[i] = pixels[base + ((i >> 1) * width + (i & 1)) * 3 + k]
        const { a, b } = fit(glyph, channel, 0, 255)
        colors[cell * 6 + k] = Math.round(b)
        colors[cell * 6 + 3 + k] = Math.round(a)
      }
      // A blank glyph shows no foreground: one pair per background.
      if (glyph.cp === 0x20) for (let k = 0; k < 3; k++) colors[cell * 6 + k] = colors[cell * 6 + 3 + k]
    }
  }
}

// A Raster paints 1024 color pairs exactly. Median cut over the cells' pairs
// (six channels) keeps a frame within them: boxes split at the median of
// their widest channel, every cell given its box's mean pair.
const limitPairs = () => {
  const { count, colors, order } = grid
  if (count <= MAX_PAIRS) return
  const seen = new Set()
  for (let cell = 0; cell < count && seen.size <= MAX_PAIRS; cell++) {
    const at = cell * 6
    seen.add(((colors[at] << 16) | (colors[at + 1] << 8) | colors[at + 2]) * 0x1000000 +
      ((colors[at + 3] << 16) | (colors[at + 4] << 8) | colors[at + 5]))
  }
  if (seen.size <= MAX_PAIRS) return
  for (let i = 0; i < count; i++) order[i] = i
  const measure = (lo, hi) => {
    let widest = 0, span = -1
    for (let k = 0; k < 6; k++) {
      let least = 255, most = 0
      for (let i = lo; i < hi; i++) {
        const v = colors[order[i] * 6 + k]
        if (v < least) least = v
        if (v > most) most = v
      }
      if (most - least > span) { span = most - least; widest = k }
    }
    return { lo, hi, widest, span }
  }
  const boxes = [measure(0, count)]
  while (boxes.length < MAX_PAIRS) {
    let pick = -1, span = 0
    for (let i = 0; i < boxes.length; i++) if (boxes[i].span > span) { span = boxes[i].span; pick = i }
    if (pick < 0) break
    const { lo, hi, widest } = boxes[pick]
    order.subarray(lo, hi).sort((p, q) => colors[p * 6 + widest] - colors[q * 6 + widest])
    // Split between two different values, as near the median as they allow.
    let middle = (lo + hi) >> 1
    const value = colors[order[middle] * 6 + widest]
    if (colors[order[lo] * 6 + widest] === value) {
      while (middle < hi && colors[order[middle] * 6 + widest] === value) middle++
    } else {
      while (colors[order[middle - 1] * 6 + widest] === value) middle--
    }
    boxes[pick] = measure(lo, middle)
    boxes.push(measure(middle, hi))
  }
  const sum = [0, 0, 0, 0, 0, 0]
  for (const { lo, hi } of boxes) {
    sum.fill(0)
    for (let i = lo; i < hi; i++) for (let k = 0; k < 6; k++) sum[k] += colors[order[i] * 6 + k]
    for (let i = lo; i < hi; i++) for (let k = 0; k < 6; k++) colors[order[i] * 6 + k] = sum[k] / (hi - lo)
  }
}

const toCells = () => {
  const { count, codePoints, colors, words } = grid
  for (let cell = 0; cell < count; cell++) {
    const at = cell * 6
    words[cell * 3] = codePoints[cell]
    words[cell * 3 + 1] = (colors[at] << 16) | (colors[at + 1] << 8) | colors[at + 2]
    words[cell * 3 + 2] = (colors[at + 3] << 16) | (colors[at + 4] << 8) | colors[at + 5]
  }
  return Buffer.from(words.buffer, words.byteOffset, words.byteLength).toString('base64')
}

// One SVG document of the same cells, for a surface with no Raster: the
// backgrounds as one path per color, the glyphs as one text row per cell row.
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;' }
const toSvg = bits => {
  const { cols, rows, codePoints, colors } = grid
  const shift = 8 - bits
  const hex = at => {
    let text = '#'
    for (let k = 0; k < 3; k++) {
      const level = colors[at + k] >> shift
      text += Math.round((level * 15) / ((1 << bits) - 1)).toString(16)
    }
    return text
  }
  const paths = new Map()
  let text = ''
  for (let row = 0; row < rows; row++) {
    let line = '', run = '', fill = ''
    let start = 0, background = ''
    for (let col = 0; col <= cols; col++) {
      const at = (row * cols + col) * 6
      const here = col < cols ? hex(at + 3) : ''
      if (here !== background) {
        if (background) {
          paths.set(background, (paths.get(background) ?? '') + `M${start} ${row * 2}h${col - start}v2h${start - col}z`)
        }
        background = here
        start = col
      }
      const ink = col < cols ? hex(at) : ''
      if (ink !== fill) {
        if (run) line += `<tspan fill="${fill}">${run}</tspan>`
        fill = ink
        run = ''
      }
      if (col < cols) {
        const glyph = String.fromCharCode(codePoints[row * cols + col])
        run += ESCAPES[glyph] ?? glyph
      }
    }
    text += `<text y="${row * 2 + 1.55}" textLength="${cols}">${line}</text>`
  }
  let fills = ''
  for (const [color, d] of paths) fills += `<path fill="${color}" d="${d}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${cols} ${rows * 2}" ` +
    `font-family="Menlo,Consolas,monospace" font-size="1.66" xml:space="preserve" ` +
    `style="white-space:pre;background:#000">${fills}${text}</svg>`
}

// ---------------------------------------------------------------- pictures

// A picture is the same glyph art drawn into pixels, glyphs far smaller than
// the terminal's cells, shown as one image over the pane (the kitty graphics
// protocol: Ghostty, kitty). A glyph's size in pixels, by detail level.
const DETAIL = { 1: [8, 16], 2: [6, 12], 3: [5, 10], 4: [4, 8], 5: [3, 6] }
const MAX_PICTURE = 4096 // pixels a side

// The pixels one terminal cell covers, as the terminal reports its size to
// the tty; a Retina Ghostty's at its default font where it does not say.
const cellPixels = (() => {
  if (typeof args.cell === 'string') {
    const [w, h] = args.cell.split('x').map(Number)
    if (w > 0 && h > 0) return { w, h, isMeasured: true }
  }
  try {
    const ask = 'import fcntl,os,struct,termios\n' +
      'fd=os.open("/dev/tty",os.O_RDONLY)\n' +
      'r,c,x,y=struct.unpack("HHHH",fcntl.ioctl(fd,termios.TIOCGWINSZ,bytes(8)))\n' +
      'print(x//c if c else 0,y//r if r else 0)'
    const out = execFileSync('python3', ['-c', ask], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const [w, h] = out.trim().split(/\s+/).map(Number)
    if (w >= 4 && h >= 8) return { w, h, isMeasured: true }
  } catch {}
  return { w: 16, h: 34, isMeasured: false }
})()

// Scales a mask down, each pixel the mean of the area it covers.
const shrink = (source, sw, sh, dw, dh) => {
  const out = new Uint16Array(dw * dh)
  for (let y = 0; y < dh; y++) {
    const y0 = (y * sh) / dh, y1 = ((y + 1) * sh) / dh
    for (let x = 0; x < dw; x++) {
      const x0 = (x * sw) / dw, x1 = ((x + 1) * sw) / dw
      let sum = 0, area = 0
      for (let sy = Math.floor(y0); sy < Math.ceil(y1); sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy)
        for (let sx = Math.floor(x0); sx < Math.ceil(x1); sx++) {
          const w = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx))
          sum += source[sy * sw + sx] * w
          area += w
        }
      }
      // 0 to 256, so a full pixel blends exactly to the foreground.
      out[y * dw + x] = Math.round((sum / area) * 256 / 255)
    }
  }
  return out
}

let masters = null
const maskCache = new Map()

// Every glyph of a style as a mask of a glyph's pixels.
const masksFor = (styleName, gw, gh) => {
  const key = `${styleName} ${gw}x${gh}`
  const known = maskCache.get(key)
  if (known) return known
  const masks = new Map()
  for (const glyph of styleOf(styleName).glyphs) {
    if (styleName === 'ascii') {
      masters ??= JSON.parse(readFileSync(join(HERE, 'menlo-masks.json'), 'utf8'))
      const master = masters.glyphs[glyph.cp]
      if (master) masks.set(glyph.cp, shrink(Buffer.from(master, 'base64'), masters.width, masters.height, gw, gh))
      continue
    }
    // Blocks fill their quarter cells; braille dots are rounds in theirs.
    const mask = new Uint16Array(gw * gh)
    for (let y = 0; y < gh; y++) {
      for (let x = 0; x < gw; x++) {
        const sub = Math.min(3, Math.floor((y * 4) / gh)) * 2 + Math.min(1, Math.floor((x * 2) / gw))
        if (glyph.coverage[sub] === 0) continue
        if (styleName === 'braille') {
          const cx = ((sub & 1) + 0.5) * (gw / 2), cy = ((sub >> 1) + 0.5) * (gh / 4)
          const r = Math.min(gw / 2, gh / 4) * 0.42
          if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 > r * r) continue
        }
        mask[y * gw + x] = 256
      }
    }
    masks.set(glyph.cp, mask)
  }
  maskCache.set(key, masks)
  return masks
}

let picture = null
let frameDir = ''

// A picture over `cols` by `rows` terminal cells: the glyph grid that fills
// those cells' pixels, and the pixels themselves.
const makePicture = (cols, rows, detail) => {
  const [gw, gh] = DETAIL[detail] ?? DETAIL[1]
  const across = Math.max(1, Math.min(Math.floor(MAX_PICTURE / gw), Math.floor((cols * cellPixels.w) / gw)))
  const down = Math.max(1, Math.min(Math.floor(MAX_PICTURE / gh), Math.floor((rows * cellPixels.h) / gh)))
  grid = makeGrid(across, down)
  const isFull = args.look === 'full'
  // Full color is the pane's own pixels; glyphs fill whole glyph cells of them.
  const width = isFull ? Math.min(MAX_PICTURE, cols * cellPixels.w) : across * gw
  const height = isFull ? Math.min(MAX_PICTURE, rows * cellPixels.h) : down * gh
  picture = {
    cols, rows, detail, gw, gh, width, height,
    pixels: Buffer.alloc(width * height * 3), slot: 0, generation: 0,
  }
  frameDir ||= mkdtempSync(join(tmpdir(), 'surf-frames-'))
}

// Draws every glyph cell's mask in its two colors.
const paint = () => {
  const { cols, rows, codePoints, colors } = grid
  const { gw, gh, width, pixels } = picture
  const masks = masksFor(args.style, gw, gh)
  const empty = new Uint16Array(gw * gh)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const cell = row * cols + col
      const mask = masks.get(codePoints[cell]) ?? empty
      const at = cell * 6
      const br = colors[at + 3], bg = colors[at + 4], bb = colors[at + 5]
      const dr = colors[at] - br, dg = colors[at + 1] - bg, db = colors[at + 2] - bb
      let m = 0
      for (let y = 0; y < gh; y++) {
        let out = ((row * gh + y) * width + col * gw) * 3
        for (let x = 0; x < gw; x++, m++) {
          const k = mask[m]
          pixels[out++] = br + ((dr * k) >> 8)
          pixels[out++] = bg + ((dg * k) >> 8)
          pixels[out++] = bb + ((db * k) >> 8)
        }
      }
    }
  }
}

// Writes the picture to the next of three files, so the terminal reads one
// while the next is written.
const writePicture = () => {
  picture.slot = (picture.slot + 1) % 3
  picture.generation += 1
  const path = join(frameDir, `frame-${picture.slot}.rgb`)
  writeFileSync(path, picture.pixels)
  const { cols, rows, detail, width, height, generation } = picture
  write(`I ${cols} ${rows} ${detail} ${width} ${height} ${generation} ${path}`)
}

let frames = 0
let isPlaying = false
let lastSvgAt = 0
const SVG_INTERVAL = 100 // an SVG frame is a whole redraw for its surface: ten a second

// One source picture in, one line out. A frame the reader has no room for is
// dropped: the next one is newer.
const emit = (source, sourceWidth, sourceHeight, bytesPerPixel, crop) => {
  if (isBlocked || isEnding) return
  if (args.format === 'svg') {
    if (Date.now() - lastSvgAt < SVG_INTERVAL) return
    lastSvgAt = Date.now()
  }
  const whole = crop ?? { x: 0, y: 0, w: sourceWidth, h: sourceHeight }
  if (args.format === 'image' && picture && args.look === 'full') {
    resample(source, sourceWidth, bytesPerPixel, whole, picture)
    writePicture()
    frames++
    return
  }
  resample(source, sourceWidth, bytesPerPixel, whole)
  pickCells(styleOf(args.style), args.look)
  if (args.format === 'image' && picture) {
    paint()
    writePicture()
  } else if (args.format === 'svg') {
    let svg = toSvg(4)
    if (svg.length > MAX_SVG) svg = toSvg(3)
    if (svg.length > MAX_SVG) svg = toSvg(2)
    if (svg.length > MAX_SVG) return
    write(`V ${grid.cols} ${grid.rows} ${svg}`)
  } else {
    limitPairs()
    write(`F ${grid.cols} ${grid.rows} ${toCells()}`)
  }
  frames++
  if (!isPlaying) {
    isPlaying = true
    status({ phase: 'playing', message: '' })
  }
}

// ---------------------------------------------------------------- PNG

// Decodes the PNGs Chrome's screencast sends: 8-bit RGB or RGBA, no interlace.
const decodePng = file => {
  let at = 8, width = 0, height = 0, bytesPerPixel = 0
  const data = []
  while (at < file.length) {
    const length = file.readUInt32BE(at)
    const type = file.toString('latin1', at + 4, at + 8)
    if (type === 'IHDR') {
      width = file.readUInt32BE(at + 8)
      height = file.readUInt32BE(at + 12)
      const depth = file[at + 16], color = file[at + 17], interlace = file[at + 20]
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error('an unexpected PNG format')
      bytesPerPixel = color === 6 ? 4 : 3
    } else if (type === 'IDAT') data.push(file.subarray(at + 8, at + 8 + length))
    else if (type === 'IEND') break
    at += 12 + length
  }
  const raw = inflateSync(data.length === 1 ? data[0] : Buffer.concat(data))
  const stride = width * bytesPerPixel
  const pixels = Buffer.allocUnsafe(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const from = y * (stride + 1) + 1
    const to = y * stride
    const up = to - stride
    for (let x = 0; x < stride; x++) {
      const left = x >= bytesPerPixel ? pixels[to + x - bytesPerPixel] : 0
      const above = y > 0 ? pixels[up + x] : 0
      let predicted = 0
      if (filter === 1) predicted = left
      else if (filter === 2) predicted = above
      else if (filter === 3) predicted = (left + above) >> 1
      else if (filter === 4) {
        const corner = y > 0 && x >= bytesPerPixel ? pixels[up + x - bytesPerPixel] : 0
        const p = left + above - corner
        const pa = Math.abs(p - left), pb = Math.abs(p - above), pc = Math.abs(p - corner)
        predicted = pa <= pb && pa <= pc ? left : pb <= pc ? above : corner
      }
      pixels[to + x] = (raw[from + x] + predicted) & 255
    }
  }
  return { width, height, bytesPerPixel, pixels }
}

// ---------------------------------------------------------------- a page in Chrome

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
]

const KEYS = {
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
}

// The element the page plays in: the one named like a game, else the largest
// frame, canvas or video on screen. Remembered on the window for the calls
// that follow.
const FIND_GAME = `(() => {
  let pick = document.getElementById('game-element'), area = 0
  if (!pick) for (const el of document.querySelectorAll('iframe, canvas, video')) {
    const r = el.getBoundingClientRect()
    if (r.width >= 120 && r.height >= 120 && r.width * r.height > area) { pick = el; area = r.width * r.height }
  }
  window.__surf = pick
  if (!pick) return null
  const r = pick.getBoundingClientRect()
  return { x: r.x, y: r.y, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight,
    isFull: r.x < 2 && r.y < 2 && r.x + r.width > innerWidth - 2 && r.y + r.height > innerHeight - 2
      && Boolean(document.getElementById('__surf-alone')) && pick.hasAttribute('data-surf-game'),
    hasFocus: document.activeElement === pick }
})()`

// Gives that element the whole viewport, as the page's own fullscreen button
// would: fixed over everything, its ancestors kept from confining it. (The
// Fullscreen API itself sizes a headless window to a screen it does not have.)
const FILL_GAME = `(() => {
  const el = window.__surf
  if (!el) return false
  // As the page's own fullscreen shows it: the game alone, nothing of the
  // site (its menu, its ad slots) laid over it.
  let alone = document.getElementById('__surf-alone')
  if (!alone) {
    alone = document.createElement('style')
    alone.id = '__surf-alone'
    alone.textContent = 'body * { visibility: hidden !important } [data-surf-game] { visibility: visible !important }'
    document.documentElement.appendChild(alone)
  }
  document.querySelectorAll('[data-surf-game]').forEach(node => node !== el && node.removeAttribute('data-surf-game'))
  el.setAttribute('data-surf-game', '')
  const set = (node, name, value) => node.style.setProperty(name, value, 'important')
  for (const [name, value] of [['position', 'fixed'], ['inset', '0'], ['width', '100vw'], ['height', '100vh'],
    ['max-width', 'none'], ['max-height', 'none'], ['margin', '0'], ['border', '0'], ['z-index', '2147483647'],
    ['object-fit', 'contain'], ['background', '#000']]) set(el, name, value)
  for (let node = el.parentElement; node; node = node.parentElement) {
    for (const name of ['transform', 'filter', 'backdrop-filter', 'perspective', 'contain', 'will-change']) {
      set(node, name, name === 'will-change' ? 'auto' : 'none')
    }
  }
  set(document.documentElement, 'overflow', 'hidden')
  return true
})()`

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const children = new Set()

// Starts a child this process answers for. Beside it runs a watcher that ends
// the child should this process die without the chance to (a SIGKILL), so no
// browser or player is ever left running behind a closed pane.
const startChild = (command, argv, options, graceSeconds = 1) => {
  const child = spawn(command, argv, options)
  children.add(child)
  child.on('exit', () => children.delete(child))
  if (child.pid) {
    const watch = 'while kill -0 "$1" 2>/dev/null; do sleep 1; done; kill "$2" 2>/dev/null; sleep "$3"; kill -9 "$2" 2>/dev/null'
    const watcher = spawn('/bin/sh', ['-c', watch, 'sh', String(process.pid), String(child.pid), String(graceSeconds)],
      { detached: true, stdio: 'ignore' })
    watcher.unref()
    child.on('exit', () => { try { watcher.kill() } catch {} })
  }
  return child
}

const isFullColor = () => args.format === 'image' && picture && args.look === 'full'

// The viewport a grid asks for: its shape, at about a phone's worth of pixels;
// in full color, the picture's own pixels, so the game draws at that size.
const viewportOf = () => {
  if (isFullColor()) {
    const shrink = Math.min(1, 2048 / Math.max(picture.width, picture.height))
    return { width: Math.round((picture.width * shrink) / 2) * 2, height: Math.round((picture.height * shrink) / 2) * 2 }
  }
  const aspect = grid.width / grid.height
  const width = Math.round(Math.min(1280, Math.max(320, Math.sqrt(420000 * aspect))) / 2) * 2
  const height = Math.round(Math.min(1280, Math.max(320, width / aspect)) / 2) * 2
  return { width, height }
}

const startPage = async url => {
  const chrome = args.chrome ?? CHROMES.find(path => existsSync(path))
  if (!chrome) throw new Error('No Chrome, Chromium, Brave or Edge found to run the game in.')
  const profile = args.profile ?? join(homedir(), 'Library', 'Caches', 'claude-subway-surfer', 'chrome-profile')
  mkdirSync(profile, { recursive: true })
  // The profile holds the game's progress, so one run has it at a time: the
  // lock names the run's own pid and its browser's. A live run elsewhere is
  // left alone; a browser an ended run left behind is stopped, since it would
  // swallow this launch.
  const lock = join(profile, 'surf.pid')
  const commandOf = pid => {
    try { return execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }) } catch { return '' }
  }
  let [owner, stale] = [0, 0]
  try { [owner, stale] = readFileSync(lock, 'utf8').trim().split(/\s+/).map(Number) } catch {}
  if (stale === undefined) [owner, stale] = [0, owner] // an older lock: the browser's pid alone
  if (owner && owner !== process.pid && commandOf(owner).includes('surf.mjs')) {
    throw new Error('The game is open in another session. Quit it there (q) to play it here.')
  }
  if (stale && commandOf(stale).includes(profile)) {
    try { process.kill(stale, 'SIGKILL') } catch {}
    await sleep(400)
  }
  rmSync(join(profile, 'DevToolsActivePort'), { force: true })

  let viewport = viewportOf()
  const flags = [
    `--user-data-dir=${profile}`, '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check',
    '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    `--window-size=${viewport.width},${viewport.height}`,
  ]
  if (!args.window) flags.push('--headless=new')
  if (args.mute) flags.push('--mute-audio')
  status({ phase: 'starting', message: 'Starting' })
  const browser = startChild(chrome, [...flags, 'about:blank'], { stdio: 'ignore' }, 6)
  browserChild = browser
  browser.on('exit', () => fail('The browser closed.'))
  writeFileSync(lock, `${process.pid} ${browser.pid}`)
  lockPath = lock

  let port = ''
  for (let i = 0; i < 150 && !port; i++) {
    await sleep(100)
    try { port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0] } catch {}
  }
  if (!port) throw new Error('The browser did not open its DevTools port.')
  let target
  for (let i = 0; i < 50 && !target; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = targets.find(one => one.type === 'page')
    if (!target) await sleep(100)
  }
  if (!target) throw new Error('The browser opened no page.')

  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve)
    socket.addEventListener('error', () => reject(new Error('The browser refused the DevTools connection.')))
  })
  let nextId = 0
  const waiting = new Map()
  const send = (method, params = {}) => new Promise(resolve => {
    const id = ++nextId
    waiting.set(id, resolve)
    socket.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression, options = {}) =>
    (await send('Runtime.evaluate', { expression, returnByValue: true, ...options })).result?.result?.value

  let game = null // the game element's box in the viewport, once found
  let lastSourceSize = ''
  // Nothing of the page is shown until its game fills the viewport: frames
  // before that are the site around it. A page with no game is shown after
  // a while all the same.
  let filledAt = 0
  let navigatedAt = Date.now()
  const isReady = now => (filledAt > 0 && now - filledAt > 150) || now - navigatedAt > 20000
  socket.addEventListener('message', message => {
    const event = JSON.parse(message.data)
    if (event.id) { waiting.get(event.id)?.(event); waiting.delete(event.id); return }
    if (event.method !== 'Page.screencastFrame') return
    void send('Page.screencastFrameAck', { sessionId: event.params.sessionId })
    // Every frame the page draws goes on, as fast as it draws them.
    if (!isReady(Date.now())) return
    try {
      const { width, height, bytesPerPixel, pixels } = decodePng(Buffer.from(event.params.data, 'base64'))
      if (args.debug && `${width}x${height}` !== lastSourceSize) {
        lastSourceSize = `${width}x${height}`
        status({ debug: { source: lastSourceSize } })
      }
      let crop
      if (game && !game.isFull) {
        const x = Math.max(0, Math.round((game.x * width) / game.vw))
        const y = Math.max(0, Math.round((game.y * height) / game.vh))
        const w = Math.min(width - x, Math.round((game.w * width) / game.vw))
        const h = Math.min(height - y, Math.round((game.h * height) / game.vh))
        if (w > 8 && h > 8) crop = { x, y, w, h }
      }
      emit(pixels, width, height, bytesPerPixel, crop)
    } catch (error) {
      status({ phase: 'playing', message: `A frame was skipped: ${error.message}` })
    }
  })

  const cast = async () => {
    const isFull = isFullColor()
    await send('Page.stopScreencast')
    await send('Emulation.setDeviceMetricsOverride', { ...viewport, deviceScaleFactor: 1, mobile: false })
    await send('Page.startScreencast', {
      format: 'png', everyNthFrame: 1,
      maxWidth: isFull ? viewport.width : grid.width * SUPERSAMPLE,
      maxHeight: isFull ? viewport.height : grid.height * SUPERSAMPLE,
    })
  }

  await send('Page.enable')
  await cast()
  status({ phase: 'loading', message: 'Loading' })
  await send('Page.navigate', { url })

  // The page lays its game out when it likes: look again every second, give
  // the element the whole viewport and the keyboard. Until it fills, frames
  // are cropped to its box.
  const look = async () => {
    game = (await evaluate(FIND_GAME)) ?? null
    if (args.debug) status({ debug: game })
    if (!game) return
    if (!game.isFull && (await evaluate(FILL_GAME))) game = (await evaluate(FIND_GAME)) ?? null
    if (game?.isFull && !filledAt) filledAt = Date.now()
    if (game && !game.hasFocus) await evaluate('window.__surf.focus()')
  }
  // Often until the game fills the viewport, then once a second.
  let watch = 0
  const tick = async () => {
    try { await look() } catch {}
    if (!isEnding) watch = setTimeout(tick, filledAt ? 1000 : 200)
  }
  navigatedAt = Date.now()
  void tick()

  return {
    resize: async () => { viewport = viewportOf(); await cast() },
    key: async name => {
      const key = KEYS[name]
      if (!key) return false
      const base = { key: key.key, code: key.code, windowsVirtualKeyCode: key.vk, nativeVirtualKeyCode: key.vk }
      await send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', text: key.text, ...base })
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
      return true
    },
    // A tap at a fraction of the game's box, as a mouse click.
    tap: async (fx, fy) => {
      const box = game ?? { x: 0, y: 0, w: viewport.width, h: viewport.height }
      const point = { x: box.x + fx * box.w, y: box.y + fy * box.h, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y })
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point })
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point })
      return true
    },
    shot: async path => {
      const { result } = await send('Page.captureScreenshot', { format: 'png' })
      if (!result?.data) return false
      writeFileSync(path, Buffer.from(result.data, 'base64'))
      return true
    },
    evaluate,
    close: () => { void send('Browser.close'); return true },
    stop: () => { clearTimeout(watch); try { socket.close() } catch {} },
  }
}

// ---------------------------------------------------------------- a video file

const startVideo = async file => {
  const ffmpeg = args.ffmpeg ?? 'ffmpeg'
  const probe = args.ffprobe ?? 'ffprobe'
  let size = { width: 16, height: 9, duration: 0 }
  try {
    const out = execFileSync(probe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=width,height:format=duration', '-of', 'json', file], { encoding: 'utf8' })
    const info = JSON.parse(out)
    size = { width: info.streams[0].width, height: info.streams[0].height, duration: Number(info.format.duration) || 0 }
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'A video needs ffmpeg, and none was found (brew install ffmpeg).'
      : `ffprobe could not read ${file}`)
  }
  status({ phase: 'loading', message: 'Loading' })
  const startedAt = Date.now()
  let decoder = null

  if (!args.mute) {
    const player = startChild(args.ffplay ?? 'ffplay', ['-nodisp', '-loglevel', 'quiet', '-loop', '0', file], { stdio: 'ignore' })
    player.on('error', () => status({ phase: 'playing', message: 'No ffplay: the video plays without sound.' }))
  }

  // ffmpeg decodes at the playback rate, scaled to the size the grid shows it
  // at, from where the sound is now.
  const decode = () => {
    const target = isFullColor() ? picture : grid
    const scale = Math.min(target.width / size.width, target.height / size.height)
    const width = Math.max(2, Math.round(size.width * scale))
    const height = Math.max(2, Math.round(size.height * scale))
    const elapsed = (Date.now() - startedAt) / 1000
    const seek = size.duration > 0 ? elapsed % size.duration : 0
    const child = startChild(ffmpeg, ['-v', 'error', '-re', '-ss', seek.toFixed(2), '-stream_loop', '-1', '-i', file, '-an',
      '-vf', `scale=${width}:${height}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
    { stdio: ['ignore', 'pipe', 'ignore'] })
    const frameBytes = width * height * 3
    let held = Buffer.alloc(0)
    child.stdout.on('data', chunk => {
      held = held.length ? Buffer.concat([held, chunk]) : chunk
      while (held.length >= frameBytes) {
        if (child === decoder) emit(held.subarray(0, frameBytes), width, height, 3)
        held = held.subarray(frameBytes)
      }
    })
    child.on('error', () => fail('ffmpeg did not start.'))
    child.on('exit', code => { if (child === decoder && code) fail('ffmpeg stopped.') })
    return child
  }
  decoder = decode()

  return {
    resize: async () => { const old = decoder; decoder = decode(); old.kill('SIGKILL') },
    key: async () => false,
    tap: async () => false,
    stop: () => {},
  }
}

// ---------------------------------------------------------------- lifecycle

let source = null
let server = null
let socketDir = ''
let browserChild = null
let lockPath = ''

const BROWSER_GRACE = 4000 // how long a closing browser has to write the game's save

function end(code) {
  if (isEnding) return
  isEnding = true
  try { server?.close() } catch {}
  try { if (socketDir) rmSync(socketDir, { recursive: true, force: true }) } catch {}
  try { if (frameDir) rmSync(frameDir, { recursive: true, force: true }) } catch {}
  try { if (typeof args.sock === 'string') rmSync(args.sock, { force: true }) } catch {}
  try { if (lockPath && readFileSync(lockPath, 'utf8').startsWith(`${process.pid} `)) rmSync(lockPath) } catch {}
  // The browser closes as a person would close it, so the page saves what it
  // keeps; the other children stop now. Whatever outlasts the grace is forced.
  let isClosing = false
  try { isClosing = source?.close?.() ?? false } catch {}
  setTimeout(() => { try { source?.stop() } catch {} }, 100)
  for (const child of children) {
    if (!(isClosing && child === browserChild)) { try { child.kill('SIGTERM') } catch {} }
  }
  const started = Date.now()
  const wait = setInterval(() => {
    const elapsed = Date.now() - started
    if (children.size > 0 && elapsed < BROWSER_GRACE + 600) {
      if (elapsed >= BROWSER_GRACE) for (const child of children) { try { child.kill('SIGTERM') } catch {} }
      return
    }
    clearInterval(wait)
    for (const child of children) { try { child.kill('SIGKILL') } catch {} }
    process.exit(code)
  }, 50)
}

function fail(message) {
  if (isEnding) return
  status({ phase: 'error', message })
  end(1)
}

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => end(0))
process.on('uncaughtException', error => fail(error.message))
process.on('unhandledRejection', error => fail(error?.message ?? String(error)))

// The parent gone without a signal (a crash) reparents this process.
const parent = process.ppid
setInterval(() => { if (process.ppid !== parent) end(0) }, 2000).unref()

setInterval(() => {
  if (isPlaying) status({ phase: 'playing', fps: frames / 2 })
  frames = 0
}, 2000).unref()

const control = async (path, query) => {
  if (process.env.SURF_CONTROL_LOG) {
    try { writeFileSync(process.env.SURF_CONTROL_LOG, `${path}?${query}\n`, { flag: 'a' }) } catch {}
  }
  if (path === '/ping') return true
  if (path === '/quit') { setTimeout(() => end(0), 10); return true }
  if (path === '/shot' && args.debug) return source?.shot?.(query.get('path')) ?? false
  if (path === '/others' && args.debug) {
    return String(await source?.evaluate?.(`[...document.querySelectorAll('body *')].filter(el => {
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility === 'visible' && !el.hasAttribute('data-surf-game')
    }).length`))
  }
  if (path === '/key') return source?.key(query.get('k')) ?? false
  if (path === '/tap') return source?.tap(Number(query.get('x') ?? 0.5), Number(query.get('y') ?? 0.5)) ?? false
  if (path === '/look') {
    if (!LOOKS.includes(query.get('l'))) return false
    const wasFull = args.look === 'full'
    args.look = query.get('l')
    // Into or out of full color, the picture has another size and the source
    // is asked for other pixels.
    if (wasFull !== (args.look === 'full')) {
      if (picture) makePicture(picture.cols, picture.rows, picture.detail)
      await source?.resize()
    }
    return true
  }
  if (path === '/style') {
    if (!GLYPHS[query.get('s')]) return false
    args.style = query.get('s')
    return true
  }
  if (path === '/size') {
    const cols = Math.round(Number(query.get('cols'))), rows = Math.round(Number(query.get('rows')))
    if (!(cols >= 1 && cols <= 512 && rows >= 1 && rows <= 256)) return false
    const format = query.get('format')
    if (format) args.format = format === 'svg' || format === 'image' ? format : 'cells'
    const detail = Math.round(Number(query.get('detail') ?? args.detail))
    if (DETAIL[detail]) args.detail = detail
    if (args.format === 'image') {
      if (!picture || picture.cols !== cols || picture.rows !== rows || picture.detail !== args.detail) {
        makePicture(cols, rows, args.detail)
        await source?.resize()
      }
    } else if (picture || cols !== grid.cols || rows !== grid.rows) {
      picture = null
      grid = makeGrid(cols, rows)
      await source?.resize()
    }
    return true
  }
  return false
}

const main = async () => {
  if (typeof WebSocket !== 'function') throw new Error(`Node 22 or newer is needed (this is ${process.version}).`)
  if (args.format === 'image') makePicture(Math.min(255, args.cols), Math.min(255, args.rows), args.detail)
  else grid = makeGrid(Math.min(512, args.cols), Math.min(256, args.rows))
  styleOf(args.style)

  // The socket sits in a directory of this user's alone: the one the mod
  // names (one per session), else a fresh one.
  let sock = ''
  if (typeof args.sock === 'string') {
    sock = args.sock
    mkdirSync(dirname(sock), { recursive: true, mode: 0o700 })
    rmSync(sock, { force: true })
  } else {
    socketDir = mkdtempSync(join(tmpdir(), 'surf-'))
    sock = join(socketDir, 's')
  }
  server = createServer((request, response) => {
    const url = new URL(request.url, 'http://surf')
    control(url.pathname, url.searchParams).then(
      ok => { response.writeHead(ok ? 200 : 400).end(typeof ok === 'string' ? ok : ok ? 'ok' : 'no') },
      error => { response.writeHead(500).end(String(error.message)) },
    )
  })
  await new Promise(resolve => server.listen(sock, resolve))
  status({ sock })

  if (args.video) {
    if (!/^https?:/.test(args.video) && !(existsSync(args.video) && statSync(args.video).isFile())) {
      throw new Error(`No such file: ${args.video}`)
    }
    source = await startVideo(args.video)
  } else {
    source = await startPage(args.url)
  }
}

main().catch(error => fail(error.message))
