import { expect, mock, test } from 'claude-code/testing'
import type { Engine, MockClock } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  title: 'Subway Surfers',
  isFocused: true,
  bodyColumns: 40,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 24 },
} as const

// One orange full block per cell, as the frame source would send it.
const cellsOf = (cols: number, rows: number) => {
  const words = new Uint32Array(cols * rows * 3)
  for (let at = 0; at < words.length; at += 3) words.set([0x2588, 0xff8800, 0x000000], at)
  return new Uint8Array(words.buffer).toBase64()
}

type Blit = { kind: 'image' | 'cells'; columns?: number; rows?: number; source?: unknown }

// A frame source that prints what the test queues, one line a piece, and
// answers a resize with a frame of the asked size and encoding, until the test
// ends it.
const fakeSource = (on: On, options: { deny?: string } = {}) => {
  const sent: string[] = []
  const blits: Blit[] = []
  const queued: string[] = []
  let argv: readonly string[] = []
  let isFinished = false
  let wake = () => {}
  const push = (line: string) => {
    queued.push(line)
    wake()
  }
  const frameFor = (format: string, cols: number, rows: number, detail: number, generation = 1) =>
    format === 'image'
      ? `I ${cols} ${rows} ${detail} 640 1088 ${generation} /tmp/surf-frames/frame-${generation % 3}.rgb`
      : format === 'svg'
        ? `V ${cols} ${rows} <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"></svg>`
        : `F ${cols} ${rows} ${cellsOf(cols, rows)}`

  on('process.run', () => ({
    value: { exitCode: 0, stdout: '/usr/local/bin/node\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('process.spawn', async function* (_, e) {
    argv = e.argv
    const arg = (name: string) => argv[argv.indexOf(name) + 1] ?? ''
    yield { stream: 'stdout', text: 'S {"sock":"/tmp/surf-test/s"}\nS {"phase":"playing","message":"","fps":30}\n' }
    yield { stream: 'stdout', text: `${frameFor(arg('--format'), Number(arg('--cols')), Number(arg('--rows')), Number(arg('--detail')))}\n` }
    while (!isFinished) {
      const line = queued.shift()
      if (line) yield { stream: 'stdout', text: `${line}\n` }
      else await new Promise<void>(resolve => { wake = resolve })
    }

    return { value: { code: 0, signal: null } }
  })
  on('http.fetch', (_, e) => {
    const url = new URL(e.url)
    if (url.pathname === '/size') {
      const query = url.searchParams
      push(frameFor(query.get('format') ?? '', Number(query.get('cols')), Number(query.get('rows')), Number(query.get('detail'))))
    } else {
      sent.push(`${e.init?.socketPath} ${e.url}`)
    }

    return { value: { status: 200, ok: true, headers: {}, text: 'ok' } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'test-session-0001' }))
  on('ui.blit', (_, e) => {
    const isImage = 'source' in e
    blits.push(isImage ? { kind: 'image', columns: e.columns, rows: e.rows, source: e.source } : { kind: 'cells', columns: e.columns, rows: e.rows })

    return { value: isImage && options.deny ? { deny: options.deny } : {} }
  })

  return {
    sent, blits, push, frameFor,
    argv: () => argv,
    finish: () => {
      isFinished = true
      wake()
    },
  }
}

const start = async ($: Engine, on: On, clock: MockClock, surface: 'terminal' | 'desktop') => {
  mock.env(on, { HOME: '/home/me', PATH: '/usr/bin', TMPDIR: '/tmp/' })
  const ui = await $.ui.mount({ plugin: 'subway-surfer', surface, component: 'Pane', requestId: 'surf', props: PANE })
  expect(await ui.find({ type: 'Text', text: /\/surf plays the game/ })).toBeDefined()
  const ran = await $.command.run({ command: 'surf', args: '' })
  expect(ran.text).toBe('Starting Subway Surfers.')
  await clock.advance(200)
  await clock.settle()

  return ui
}

const SLOW = { timeoutMs: 30_000 }

test('the terminal plays the game in full color, steers, and cycles its views', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  const source = fakeSource(on)
  const ui = await start($, on, clock, 'terminal')

  const argv = source.argv()
  expect(argv[argv.indexOf('--format') + 1]).toBe('image')
  expect(argv[argv.indexOf('--detail') + 1]).toBe('1')
  expect(argv[argv.indexOf('--look') + 1]).toBe('full')
  // 24 body rows less the three under the picture.
  const image = await ui.find({ type: 'Image' })
  expect(image?.props.columns).toBe(40)
  expect(image?.props.rows).toBe(21)
  expect(source.blits[0]).toEqual({
    kind: 'image', columns: 40, rows: 21,
    source: { file: '/tmp/surf-frames/frame-1.rgb', format: 'rgb', width: 640, height: 1088, generation: 1 },
  })
  expect(await ui.find({ type: 'Text', text: /640×1088 px/ })).toBeDefined()

  // The four moves, and e for space: what starts a run and each new round.
  await ui.press({ key: 'left' })
  await ui.press({ key: 'start' })

  // v: ascii glyphs, a picture still; then the terminal's own characters.
  expect((await ui.find({ key: 'view' }))?.text).toContain('full color')
  await ui.press({ key: 'view' })
  expect(await ui.find({ type: 'Image' })).toBeDefined()
  expect((await ui.find({ key: 'view' }))?.text).toContain('ascii')
  await ui.press({ key: 'view' })
  source.push(source.frameFor('image', 40, 21, 1, 2))
  await clock.settle()
  expect((await ui.find({ type: 'Raster' }))?.props.rows).toBe(21)
  expect(source.blits.at(-1)).toEqual({ kind: 'cells', columns: 40, rows: 21 })
  expect(source.sent).toEqual([
    '/tmp/surf-test/s http://surf/key?k=left',
    '/tmp/surf-test/s http://surf/key?k=space',
    '/tmp/surf-test/s http://surf/look?l=ascii',
    '/tmp/surf-test/s http://surf/look?l=ascii',
  ])

  // The frame source ending on its own is said in the pane, not hidden.
  source.finish()
  await clock.settle()
  expect(await ui.find({ type: 'Text', text: /The game closed/ })).toBeDefined()
})

test('q quits: the frame source is told to end and the pane closes', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  const source = fakeSource(on)
  const closed: string[] = []
  on('ui.close', (_, e) => {
    closed.push(e.id)

    return { value: undefined }
  })
  const ui = await start($, on, clock, 'terminal')

  await ui.press({ key: 'quit' })

  expect(source.sent).toEqual(['/tmp/surf-test/s http://surf/quit'])
  expect(closed).toEqual(['surf'])
  source.finish()
  await clock.settle()
})

test('a terminal that refuses pictures gets cells', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  const source = fakeSource(on, { deny: 'the Image draws its alt here' })
  const ui = await start($, on, clock, 'terminal')

  for (let generation = 2; generation <= 45; generation++) source.push(source.frameFor('image', 40, 21, 1, generation))
  await clock.settle()

  expect(await ui.find({ type: 'Raster' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /no picture here/ })).toBeDefined()
  source.finish()
  await clock.settle()
})

test('the desktop plays the same cells as SVG', SLOW, async ($, on) => {
  const clock = mock.clock(on)
  const source = fakeSource(on)
  const ui = await start($, on, clock, 'desktop')

  expect(source.argv()).toContain('svg')
  expect((await ui.find({ type: 'Svg' }))?.props.source).toContain('<svg')
  source.finish()
  await clock.settle()
})

test('a file that is not there is refused without opening the pane', async ($, on) => {
  mock.env(on, { HOME: '/home/me' })
  on('fs.stat', () => {
    throw new Error('ENOENT')
  })

  const ran = await $.command.run({ command: 'surf', args: 'missing.mp4' })

  expect(ran.text).toStartWith('No such file: missing.mp4')
})
