import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Phase, Style, View } from '../types'

const PANE = 'surf'
const SCREEN = 'screen'
const PICTURE = 'picture'
// The rows the pane draws under the picture: a status line and two of keys.
const CHROME_ROWS = 3
// The views `v` cycles, as the pane names them.
const MODES: readonly Mode[] = ['full', 'ascii', 'cells']
const MODE_NAMES: Record<Mode, string> = { ascii: 'ascii', full: 'full color', cells: 'characters' }
// How small the ascii picture's glyphs are: 1 is the largest, 8 by 16 pixels.
const DETAIL = 1
const STYLES: readonly Style[] = ['ascii', 'blocks', 'braille']
// A picture's source before its first frame: one black pixel, stretched.
const BLACK = { rgba: 'AAAA/w==', width: 1, height: 1 }
// Pictures refused in a row before the pane draws cells instead: this
// terminal draws an Image's alt (it has no kitty graphics).
const REFUSALS = 45
const PHASES: readonly Phase[] = ['idle', 'starting', 'loading', 'playing', 'error']
const MEDIA = /\.(mp4|m4v|mov|mkv|webm|avi|gif|m3u8)([?#].*)?$/i

const IDLE: View = {
  phase: 'idle', message: '', source: '', style: 'ascii', mode: 'full', fps: 0,
}
const view = atom({ plugin: 'subway-surfer', key: 'view' } as const, IDLE)

type Request = { kind: 'page' | 'video'; target: string; label: string }
type Wanted = { format: 'cells' | 'svg' | 'image'; cols: number; rows: number; detail: number }
type PictureSource = { file: string; format: 'rgb'; width: number; height: number; generation: number }
type Run = { sock: string }

// What the pane last drew: the size and encoding its frames must come in.
let wanted: Wanted | undefined
// The frame source's run, while one plays; the loop reading it ends when this
// is no longer its own.
let run: Run | undefined
// The last frame, so a redraw of the pane shows it rather than a blank.
let frame: { cols: number; rows: number; cells: string } | undefined
let svg = ''
let shown: { cols: number; rows: number; detail: number; source: PictureSource } | undefined
let refused = 0
let asked = ''
let unanswered = 0
let node: string | undefined

const clamp = (value: number, least: number, most: number) => Math.min(most, Math.max(least, Math.round(value)))

// A Raster's cells before the first frame: spaces on black.
const blank = (cols: number, rows: number) => {
  const words = new Uint32Array(cols * rows * 3)
  for (let at = 0; at < words.length; at += 3) words[at] = 0x20
  return new Uint8Array(words.buffer).toBase64()
}

// The absolute path of a command, as the person's shell finds it: the host
// process of a desktop app has no Homebrew or version manager on its PATH.
const locate = async ($: EngineInterface, name: string) => {
  const ways = [['/usr/bin/which', name], ['/bin/zsh', '-lc', `command -v ${name}`], ['/bin/zsh', '-lic', `command -v ${name}`]]
  for (const argv of ways) {
    try {
      const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: 8000 })
      const path = stdout.split('\n').map(line => line.trim()).filter(line => line.startsWith('/')).pop()
      if (exitCode === 0 && path) return path
    } catch {
      // The next way may still find it.
    }
  }
  return undefined
}

const send = async ($: EngineInterface, path: string) => {
  const sock = run?.sock
  if (!sock) return
  try {
    await $.http.fetch(`http://surf${path}`, { method: 'POST', socketPath: sock })
  } catch {
    // The frame source is gone; its loop says so.
  }
}

const stop = async ($: EngineInterface) => {
  if (!run) return
  await send($, '/quit')
  run = undefined
  await update($, view, now => ({ ...now, phase: 'idle', message: '', fps: 0 }))
}

// Draws one frame line: `F cols rows cells` repaints the Raster in place,
// `I cols rows detail width height generation file` swaps the picture's
// file, `V cols rows svg` redraws the pane. A frame of another size or
// encoding than the pane shows is skipped and the right one asked for.
const draw = async ($: EngineInterface, line: string) => {
  if (!wanted) return
  const first = line.indexOf(' ', 2)
  const second = line.indexOf(' ', first + 1)
  const format = line.startsWith('V') ? 'svg' : line.startsWith('I') ? 'image' : 'cells'
  const cols = Number(line.slice(2, first))
  const rows = Number(line.slice(first + 1, second))
  const fields = format === 'image' ? line.slice(second + 1).split(' ') : []
  const detail = format === 'image' ? Number(fields[0]) : wanted.detail
  if (format !== wanted.format || cols !== wanted.cols || rows !== wanted.rows || detail !== wanted.detail) {
    const ask = `/size?cols=${wanted.cols}&rows=${wanted.rows}&format=${wanted.format}&detail=${wanted.detail}`
    unanswered += 1
    if (ask !== asked || unanswered > 60) {
      asked = ask
      unanswered = 0
      await send($, ask)
    }
    return
  }
  if (format === 'image') {
    const [, width, height, generation, ...path] = fields
    const source: PictureSource = {
      file: path.join(' '), format: 'rgb', width: Number(width), height: Number(height), generation: Number(generation),
    }
    shown = { cols, rows, detail, source }
    const { deny } = await $.ui.blit({ requestId: PANE, key: PICTURE, source, columns: cols, rows })
    refused = deny ? refused + 1 : 0
    if (refused === REFUSALS) {
      await update($, view, now => ({ ...now, mode: 'cells', message: `no picture here (${deny}), so cells` }))
    }
    return
  }
  const data = line.slice(second + 1)
  if (format === 'svg') {
    svg = data
    $.ui.invalidate('ui.render')
    return
  }
  frame = { cols, rows, cells: data }
  await $.ui.blit({ requestId: PANE, key: SCREEN, cells: data, columns: cols, rows })
}

const hear = async ($: EngineInterface, mine: Run, json: string) => {
  let said: { sock?: unknown; phase?: unknown; message?: unknown; fps?: unknown }
  try {
    said = JSON.parse(json)
  } catch {
    return
  }
  if (typeof said.sock === 'string') {
    mine.sock = said.sock
    return
  }
  const phase = PHASES.find(one => one === said.phase)
  await update($, view, now => ({
    ...now,
    phase: phase ?? now.phase,
    message: typeof said.message === 'string' ? said.message : now.message,
    fps: typeof said.fps === 'number' ? Math.round(said.fps) : now.fps,
  }))
}

// Runs the frame source and draws what it prints until it ends or another
// run takes its place. Leaving the loop is what ends the child.
const play = async ($: EngineInterface, request: Request, options: { sound: boolean }) => {
  const mine: Run = { sock: '' }
  run = mine
  frame = undefined
  svg = ''
  shown = undefined
  refused = 0
  asked = ''
  const { style, mode } = await read($, view)
  await update($, view, now => ({ ...now, phase: 'starting', message: 'Starting', source: request.label, fps: 0 }))

  node ??= await locate($, 'node')
  if (!node) {
    run = undefined
    await update($, view, now => ({ ...now, phase: 'error', message: 'Node.js 22 or newer is needed and none was found.' }))
    return
  }
  const size = wanted ?? { format: 'cells', cols: 60, rows: 40, detail: DETAIL }
  const home = (await $.env.get('HOME')) ?? ''
  const path = (await $.env.get('PATH')) ?? '/usr/bin:/bin'
  const temp = ((await $.env.get('TMPDIR')) ?? '/tmp').replace(/\/$/, '')
  const session = (await $.session.id()).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)
  const argv = [
    node, `${$.plugin.root}/bin/surf.mjs`,
    '--sock', `${temp}/surf-${session}/s`,
    '--cols', String(size.cols), '--rows', String(size.rows), '--format', size.format,
    '--style', style, '--look', mode === 'full' ? 'full' : 'ascii', '--detail', String(DETAIL),
    request.kind === 'video' ? '--video' : '--url', request.target,
  ]
  if (!options.sound) argv.push('--mute')

  let ended = 'The game closed.'
  try {
    const child = $.process.spawn({
      argv,
      env: { PATH: `${node.slice(0, node.lastIndexOf('/'))}:/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:${path}` },
    })
    let held = ''
    for await (const { stream, text } of child) {
      if (run !== mine) break
      if (stream === 'stderr') continue
      held += text
      const end = held.lastIndexOf('\n')
      if (end < 0) continue
      const lines = held.slice(0, end).split('\n')
      held = held.slice(end + 1)
      // Statuses in order; of the frames that came together, the newest.
      let newest = ''
      for (const line of lines) {
        if (line.startsWith('S ')) await hear($, mine, line.slice(2))
        else if (line.startsWith('F ') || line.startsWith('I ') || line.startsWith('V ')) newest = line
      }
      if (newest) await draw($, newest)
    }
  } catch (error) {
    ended = `The frame source failed: ${error instanceof Error ? error.message : String(error)}`
  }
  if (run !== mine) return
  run = undefined
  await update($, view, now => (now.phase === 'error' ? now : { ...now, phase: 'error', message: ended }))
}

// What `/surf <argument>` asks to play: nothing is the game page, a file or a
// media URL a video, any other URL a page.
const resolve = async ($: EngineInterface, argument: string, page: string): Promise<Request | string> => {
  const target = argument.replace(/^(['"])(.*)\1$/, '$2')
  const host = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return undefined
    }
  }
  if (!target) return { kind: 'page', target: page, label: 'Subway Surfers' }
  if (/^https?:\/\//.test(target)) {
    const label = host(target)
    if (!label) return `Not a URL: ${target}`
    return { kind: MEDIA.test(target) ? 'video' : 'page', target, label }
  }
  const home = (await $.env.get('HOME')) ?? ''
  const file = target.replace(/^~(?=\/)/, home)
  try {
    const { kind } = await $.fs.stat(file)
    if (kind === 'file') return { kind: 'video', target: file, label: file.slice(file.lastIndexOf('/') + 1) }
  } catch {
    // Reported below.
  }
  return `No such file: ${target}. /surf takes a video file, a URL, a glyph style (${STYLES.join(', ')}) or stop.`
}

export const register: Register = (on, options) => {
  const page = typeof options.url === 'string' && options.url ? options.url : 'https://poki.com/en/g/subway-surfers'
  const startStyle = STYLES.find(one => one === options.style) ?? 'ascii'
  const playback = { sound: options.sound !== false }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'surf',
      description: 'Play Subway Surfers, or a video, as glyphs in a pane',
      argumentHint: '[video file | URL | ascii | blocks | braille | stop]',
    })
    // A reload ended whatever played: the pane starts over, its choices kept.
    await update($, view, now => ({
      ...IDLE, style: now?.style ?? startStyle,
    }))

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await stop($)

    return next(e)
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    await stop($)

    return next(e)
  })

  on('command.run', { command: 'surf' }, async ($, e) => {
    const argument = e.args.trim()

    if (argument === 'stop' || argument === 'quit' || argument === 'off') {
      await stop($)
      await $.ui.close({ id: PANE })

      return { text: 'Stopped.' }
    }

    const style = STYLES.find(one => one === argument)
    if (style) {
      await update($, view, now => ({ ...now, style }))
      await send($, `/style?s=${style}`)

      return { text: `Drawing with ${style} glyphs.` }
    }

    const request = await resolve($, argument, page)
    if (typeof request === 'string') return { text: request }

    await stop($)
    await $.ui.open({ id: PANE, title: 'Subway Surfers', focus: true, columns: 64, rows: 36 })
    // From a timer, so the run belongs to no dispatch and the pane has drawn
    // (and said its size) before the frame source starts.
    $.clock.after(120, () => void play($, request, playback))

    return { text: `Starting ${request.label}.` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const now = await read($, view)
    const columns = clamp(e.props.bodyColumns, 16, 512)
    const key = (name: string) => () => send($, `/key?k=${name}`)
    const quit = async () => {
      await stop($)
      await $.ui.close({ id: PANE })
    }
    // v: full color, then ascii, then the terminal's characters, then full color.
    const cycle = async () => {
      const mode = MODES[(MODES.indexOf((await read($, view)).mode) + 1) % MODES.length] ?? 'full'
      refused = 0
      await update($, view, was => ({ ...was, mode, message: '' }))
      await send($, `/look?l=${mode === 'full' ? 'full' : 'ascii'}`)
    }

    let picture
    let size = ''
    if (e.surface === 'terminal') {
      const rows = clamp(e.props.scroll.bodyRows - CHROME_ROWS, 4, 256)
      if (now.mode !== 'cells') {
        // One image over the cells: small glyphs, or the game's own pixels.
        const { Image } = $.ui.resolve(e)
        const cols = Math.min(255, columns)
        const tall = Math.min(255, rows)
        wanted = { format: 'image', cols, rows: tall, detail: DETAIL }
        const current = shown && shown.cols === cols && shown.rows === tall && shown.detail === DETAIL ? shown : undefined
        if (current) size = `${current.source.width}×${current.source.height} px`
        picture = (
          <Image key={PICTURE} source={current ? current.source : BLACK} columns={cols} rows={tall}
            alt="The game, as a picture of glyphs (this terminal shows none: press x for cells)" />
        )
      } else {
        const { Raster } = $.ui.resolve(e)
        wanted = { format: 'cells', cols: columns, rows, detail: DETAIL }
        size = `${columns}×${rows} cells`
        const cells = frame && frame.cols === columns && frame.rows === rows ? frame.cells : blank(columns, rows)
        picture = <Raster key={SCREEN} columns={columns} rows={rows} cells={cells} />
      }
    } else {
      // No Raster off the terminal: the same cells arrive as one SVG, redrawn.
      const { Svg } = $.ui.resolve(e)
      const cols = Math.min(64, columns)
      wanted = { format: 'svg', cols, rows: Math.round(cols * 0.75), detail: DETAIL }
      picture = svg ? (
        <Svg source={svg} alt="The game, drawn as glyphs" width={Math.round(Math.min(cols * 9, columns * 7.2))} />
      ) : (
        <Text dimColor>Waiting for the first frame.</Text>
      )
    }

    const line =
      now.phase === 'playing'
        ? `${now.source} · ${now.fps} fps${size ? ` · ${size}` : ''}${now.message ? ` · ${now.message}` : ''}`
        : now.phase === 'idle'
          ? '/surf plays the game, /surf <file or URL> a video.'
          : `${now.message || 'Starting'}${now.phase === 'error' ? '' : '…'}`
    const hint = now.phase === 'playing' && !e.props.isFocused ? ' · click the pane or ctrl+x tab for its keys' : ''

    return (
      <Box flexDirection="column">
        {picture}
        <Text wrap="truncate" dimColor={now.phase !== 'error'} color={now.phase === 'error' ? 'red' : undefined}>
          {line}
          {hint}
        </Text>
        <Box gap={2}>
          <Button key="left" hotkey="a" plain onPress={key('left')}>left</Button>
          <Button key="right" hotkey="d" plain onPress={key('right')}>right</Button>
          <Button key="up" hotkey="w" plain onPress={key('up')}>jump</Button>
          <Button key="down" hotkey="s" plain onPress={key('down')}>roll</Button>
        </Box>
        <Box gap={2}>
          {/* Space starts the game and every new round. */}
          <Button key="start" hotkey="e" plain onPress={key('space')}>start</Button>
          {e.surface === 'terminal' && (
            <Button key="view" hotkey="v" plain onPress={cycle}>{`${MODE_NAMES[now.mode]} view`}</Button>
          )}
          <Button key="quit" hotkey="q" plain onPress={quit}>quit</Button>
        </Box>
      </Box>
    )
  })
}
