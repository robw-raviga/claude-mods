import { expect, mock, test } from 'claude-code/testing'

declare const setTimeout: (fn: (...args: never[]) => void, ms: number) => unknown
import type { On } from 'claude-code'

import type { Item } from '../types'
import { applyExtraction, numbered, parseExtraction, promptSection } from './extract'

type Reply = (prompt: string) => string

// The engine beneath the plugin: a clock, a store, a session id, a model that
// answers from `reply`, and the rest of what the mod calls.
const bottom = (on: On, reply: Reply) => {
  const prompts: string[] = []
  const filled: string[] = []
  const stored: Record<string, unknown> = {}
  let latest: Item[] = []
  let turns = 0
  mock.clock(on, { now: 1_700_000_000_000 })
  on('store.get', (_, e) => ({ value: stored[e.key] }))
  on('store.set', (_, e) => {
    stored[e.key] = e.value
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'session-1' }))
  on('session.turns', () => ({ value: turns }))
  on('tool.call', () => ({ result: { text: 'ok' } }) as never)
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('turn.start', (_, e) => {
    turns += 1
    return { turnId: e.turnId }
  })
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('prompt.compose', () => ({ sections: [] }))
  on('model.complete', (_, e) => {
    prompts.push(e.prompt)
    return { value: { isAnswered: true as const, text: reply(e.prompt), usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('state.set', { plugin: 'ledger', key: 'items' }, (_, e, next) => {
    latest = e.value as Item[]
    return next(e)
  })

  // The extraction runs after turn.complete answers, so a test waits for its write.
  const settled = async (until: (items: Item[]) => boolean) => {
    for (let i = 0; i < 200 && !until(latest); i++) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return latest
  }

  return { prompts, settled, items: () => latest, stored, filled }
}

const turn = (turnId: string, answer: string) =>
  ({ turnId, answer, durationMs: 10, isAborted: false, reason: 'answer' as const })

const command = (name: string, args: string) =>
  ({ command: name, args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

test('parseExtraction reads JSON out of prose and drops bad entries', () => {
  const found = parseExtraction('Sure:\n```json\n{"add":[{"kind":"task","text":"Write tests"},{"kind":"nope","text":"x"},{"kind":"question"}],"close":["a1",7]}\n```')
  expect(found).toEqual({ add: [{ kind: 'task', text: 'Write tests' }], close: ['a1'] })
  expect(parseExtraction('no json here')).toBeUndefined()
})

test('applyExtraction closes by id, skips duplicates, files decisions as done', () => {
  const open: Item[] = [
    { id: 'a1', kind: 'task', text: 'Write tests', status: 'open', turn: 1, source: 'model' },
    { id: 'a2', kind: 'question', text: 'Use Haiku?', status: 'open', turn: 1, source: 'model' },
  ]
  let n = 0
  const after = applyExtraction(
    open,
    { add: [{ kind: 'task', text: 'write tests' }, { kind: 'decision', text: 'Haiku it is' }], close: ['a2'] },
    2,
    () => `b${n++}`,
  )
  expect(after.map(i => `${i.id}:${i.kind}:${i.status}`)).toEqual(['a1:task:open', 'a2:question:done', 'b0:decision:done'])
  expect(numbered(after).map(i => i.id)).toEqual(['a1'])
  expect(promptSection(after)).toContain('- Write tests')
  expect(promptSection(after)).toContain('- Haiku it is')
  expect(promptSection([])).toBeUndefined()
})

test('a completed turn asks the model with the turn facts and records what it found', async ($, on) => {
  const world = bottom(
    on,
    () => '{"add":[{"kind":"task","text":"Add a README"},{"kind":"question","text":"Pin the pane by default?"}],"close":[]}',
  )
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'Make a ledger mod', turnId: 't1' })
  await $.tool.call({ tool: 'Write', tool_use_id: 'u1', file_path: '/work/README.md', content: '' } as never)
  await $.turn.complete(turn('t1', 'Done. Should I pin the pane by default?'))

  const items = await world.settled(list => list.length === 2)
  expect(world.prompts).toHaveLength(1)
  expect(world.prompts[0]).toContain('Make a ledger mod')
  expect(world.prompts[0]).toContain('Write: /work/README.md')
  expect(world.prompts[0]).toContain('Should I pin the pane by default?')
  expect(items.map(i => `${i.kind}:${i.status}:${i.source}`)).toEqual(['task:open:model', 'question:open:model'])
})

test('a subagent turn and an aborted turn are ignored', async ($, on) => {
  const world = bottom(on, () => '{"add":[{"kind":"task","text":"never"}],"close":[]}')
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete({ ...turn('t1', 'sub'), agentId: 'agent-1' })
  await $.turn.complete({ turnId: 't1', answer: '', durationMs: 1, isAborted: true, reason: 'aborted' })
  await new Promise(resolve => setTimeout(resolve, 30))
  expect(world.prompts).toHaveLength(0)
})

test('the next turn closes an item the model names, and the prompt carries open ones', async ($, on) => {
  let firstId = ''
  const world = bottom(on, prompt =>
    prompt.includes('Turn 2')
      ? `{"add":[{"kind":"decision","text":"Blue, user said so"}],"close":["${firstId}"]}`
      : '{"add":[{"kind":"question","text":"Which colour?"}],"close":[]}',
  )

  await $.turn.start({ text: 'Style the pane', turnId: 't1' })
  await $.turn.complete(turn('t1', 'Which colour?'))
  const first = (await world.settled(list => list.length === 1))[0]
  expect(first?.kind).toBe('question')
  firstId = first?.id ?? ''

  await $.turn.start({ text: 'Blue', turnId: 't2' })
  await $.turn.complete(turn('t2', 'Done, it is blue.'))
  const items = await world.settled(list => list.length === 2)
  expect(items.map(i => `${i.kind}:${i.status}`)).toEqual(['question:done', 'decision:done'])

  const composed = await $.prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const section = composed.sections.find(s => s.id === 'ledger:open')
  expect(section?.scope).toBe('session')
  expect(section?.text).toContain('Blue, user said so')
  expect(section?.text).not.toContain('Which colour?')
})

test('/task adds, /done closes by pane number, and the store keeps it', async ($, on) => {
  const world = bottom(on, () => '{"add":[],"close":[]}')
  await $.session.start({ cwd: '/work', surface: 'terminal', isInteractive: true })

  expect((await $.command.run(command('task', 'Ship it'))).text).toBe('Added task: Ship it')
  expect((await $.command.run(command('task', ''))).text).toBe('Usage: /task <what to do>')
  expect((await $.command.run(command('done', '9'))).text).toBe('Usage: /done <1-1>')
  expect((await $.command.run(command('done', '1'))).text).toBe('Done: Ship it')
  expect((await $.command.run(command('done', '1'))).text).toBe('Nothing open in the ledger.')

  expect(world.items().map(i => `${i.text}:${i.status}:${i.source}`)).toEqual(['Ship it:done:user'])
  expect((await $.command.run(command('go', '1'))).text).toBe('No open tasks in the ledger.')
  await $.command.run(command('task', 'Check the remote for PRs'))
  expect((await $.command.run(command('go', '2'))).text).toBe('Usage: /go <1-1>')
  expect((await $.command.run(command('go', '1'))).text).toBe('In the prompt box, press Enter to send: Check the remote for PRs')
  expect(world.filled).toEqual(['Please do this task from the ledger: Check the remote for PRs'])
  expect(world.stored['ledger:session-1']).toEqual(world.items())
})
