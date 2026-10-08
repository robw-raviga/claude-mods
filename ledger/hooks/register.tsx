import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Activity, Item } from '../types'
import {
  applyExtraction,
  buildPrompt,
  numbered,
  openItems,
  parseExtraction,
  promptSection,
  SYSTEM,
  type TurnFacts,
} from './extract'

const PANE = 'ledger'
const TITLE = 'Ledger'
const MODEL = 'haiku'
const EXTRACT_TIMEOUT_MS = 20000

const items = atom({ plugin: 'ledger', key: 'items' } as const, [] as Item[])
const activity = atom({ plugin: 'ledger', key: 'activity' } as const, 'idle' as Activity)
const lastError = atom({ plugin: 'ledger', key: 'lastError' } as const, '')

const storeKey = async ($: Engine) => `ledger:${await $.session.id()}`

const persist = async ($: Engine, list: Item[]) => {
  await $.store.set(await storeKey($), list)
}

const setItems = async ($: Engine, fn: (list: Item[]) => Item[]) => {
  const next = await update($, items, fn)
  await persist($, next)

  return next
}

const taskPrompt = (item: Item) => `Please do this task from the ledger: ${item.text}`

// From a button press: a turn of its own once the session is idle.
const sendTask = ($: Engine, item: Item) => $.prompt.submit({ text: taskPrompt(item), asUser: true })

// From a slash command the engine refuses a submit (it would wait on the
// command's own turn), so /go fills the box and the person presses Enter.
const draftTask = ($: Engine, item: Item) => $.prompt.fill({ text: taskPrompt(item), mode: 'replace' })

const answerQuestion = ($: Engine, item: Item) =>
  $.prompt.fill({ text: `Re "${item.text}": `, mode: 'replace' })

const mintId = (now: number) => {
  let n = 0

  return () => `${now.toString(36)}${(n++).toString(36)}`
}

// One extraction at a time, in turn order, so each sees the ledger the last one left.
let queue: Promise<void> = Promise.resolve()

const extract = async ($: Engine, facts: TurnFacts) => {
  await update($, activity, () => 'thinking')
  const open = (await read($, items)).filter(item => item.status === 'open')
  const reply = await $.model.complete({
    model: MODEL,
    system: SYSTEM,
    prompt: buildPrompt(open, facts),
    effort: 'low',
    maxTokens: 1024,
    timeoutMs: EXTRACT_TIMEOUT_MS,
  })

  if (!reply.isAnswered) {
    const why = reply.reason === 'api-error' ? `${reply.reason} ${reply.status ?? ''} ${reply.error}` : reply.reason
    await update($, lastError, () => `turn ${facts.turn}: ${why}`.trim())
    await update($, activity, () => 'error')

    return
  }

  const found = parseExtraction(reply.text)
  if (!found) {
    await update($, lastError, () => `turn ${facts.turn}: reply was not JSON`)
    await update($, activity, () => 'error')

    return
  }

  const before = await read($, items)
  const after = await setItems($, list => applyExtraction(list, found, facts.turn, mintId(Date.now())))
  await update($, lastError, () => '')
  await update($, activity, () => 'idle')

  const newQuestions = openItems(after, 'question').length - openItems(before, 'question').length
  if (newQuestions > 0) {
    $.ui.toast(`Ledger: ${newQuestions} new open question${newQuestions === 1 ? '' : 's'}`)
  }
}

export const register: Register = on => {
  // What this turn did, gathered as it runs; lost on a hot reload, which is fine.
  let userPrompt = ''
  let toolSummary: string[] = []

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ledger', description: 'Open the thread ledger pane' })
    await $.command.register({
      name: 'task',
      description: 'Add a task to the thread ledger',
      argumentHint: '<what to do>',
    })
    await $.command.register({
      name: 'done',
      description: 'Mark a ledger item done by its number in the pane',
      argumentHint: '<n>',
    })
    await $.command.register({
      name: 'go',
      description: 'Put a ledger task in the prompt box, by its number in the pane; Enter sends it',
      argumentHint: '<n>',
    })

    const held = await read($, items)
    if (held.length === 0) {
      const saved = await $.store.get(await storeKey($))
      if (Array.isArray(saved) && saved.length > 0) {
        await update($, items, () => saved as Item[])
      }
    }

    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('command.run', { command: 'ledger' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Ledger pane opened.' }
  })

  on('command.run', { command: 'task' }, async ($, e) => {
    const text = e.args.trim()
    if (!text) return { text: 'Usage: /task <what to do>' }

    const turn = await $.session.turns()
    const id = mintId(await $.clock.now())()
    await setItems($, list => [...list, { id, kind: 'task', text, status: 'open', turn, source: 'user' }])
    void $.ui.open({ id: PANE, title: TITLE })

    return { text: `Added task: ${text}` }
  })

  on('command.run', { command: 'done' }, async ($, e) => {
    const n = Number.parseInt(e.args.trim(), 10)
    const list = numbered(await read($, items))
    const target = Number.isInteger(n) ? list[n - 1] : undefined
    if (!target) return { text: list.length ? `Usage: /done <1-${list.length}>` : 'Nothing open in the ledger.' }

    await setItems($, all => all.map(item => (item.id === target.id ? { ...item, status: 'done' } : item)))

    return { text: `Done: ${target.text}` }
  })

  on('command.run', { command: 'go' }, async ($, e) => {
    const n = Number.parseInt(e.args.trim(), 10)
    const tasks = openItems(await read($, items), 'task')
    const target = Number.isInteger(n) ? tasks[n - 1] : undefined
    if (!target) return { text: tasks.length ? `Usage: /go <1-${tasks.length}>` : 'No open tasks in the ledger.' }

    const { isFilled } = await draftTask($, target)

    return { text: isFilled ? `In the prompt box, press Enter to send: ${target.text}` : 'No prompt box to fill here.' }
  })

  on('turn.start', ($, e, next) => {
    userPrompt = e.text
    toolSummary = []

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) {
      const path = 'file_path' in e && typeof e.file_path === 'string' ? e.file_path : undefined
      const command = 'command' in e && typeof e.command === 'string' ? e.command : undefined
      const detail = path ?? (command ? command.slice(0, 120) : undefined)
      toolSummary.push(detail ? `${e.tool}: ${detail}` : e.tool)
      toolSummary = toolSummary.slice(-40)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = next(e)
    const isMainAnswer = !e.agentId && e.reason === 'answer' && e.answer.trim() !== ''
    if (isMainAnswer) {
      const facts: TurnFacts = {
        turn: await $.session.turns(),
        userPrompt,
        toolSummary: [...toolSummary],
        answer: e.answer,
      }
      queue = queue.then(() => extract($, facts)).catch(async error => {
        await update($, lastError, () => `turn ${facts.turn}: ${String(error)}`)
        await update($, activity, () => 'error')
      })
    }

    return done
  })

  // Open items ride every request, so they survive compaction and a long detour.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const text = promptSection(await read($, items))
    if (!text) return composed

    return { sections: [...composed.sections, { id: 'ledger:open', text, scope: 'session' }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    const Input = 'Input' in table ? table.Input : undefined
    const all = await read($, items)
    const state = await read($, activity)
    const error = await read($, lastError)
    const tasks = openItems(all, 'task')
    const questions = openItems(all, 'question')
    const decisions = all.filter(item => item.kind === 'decision').slice(-6)
    const width = e.props.bodyColumns ?? e.viewport?.columns ?? 60

    const finish = (item: Item) => () =>
      setItems($, list => list.map(one => (one.id === item.id ? { ...one, status: 'done' } : one)))

    const row = (item: Item, n: number) => (
      <Box key={item.id} flexDirection="row" gap={1}>
        <Text dimColor>{String(n).padStart(2)}</Text>
        <Box flexGrow={1}>
          <Text wrap="wrap">{item.text}</Text>
        </Box>
        {item.kind === 'task' && (
          <Button key={`send:${item.id}`} label="send" plain onPress={() => sendTask($, item)} />
        )}
        {item.kind === 'question' && (
          <Button key={`answer:${item.id}`} label="answer" plain onPress={() => answerQuestion($, item)} />
        )}
        <Button key={`done:${item.id}`} label="done" plain onPress={finish(item)} />
      </Box>
    )

    return (
      <Box flexDirection="column" width={width} paddingX={1}>
        <Text bold>Tasks</Text>
        {tasks.length === 0 && <Text dimColor>none open</Text>}
        {tasks.map((item, i) => row(item, i + 1))}

        <Box marginTop={1}>
          <Text bold>Open questions</Text>
        </Box>
        {questions.length === 0 && <Text dimColor>none</Text>}
        {questions.map((item, i) => row(item, tasks.length + i + 1))}

        <Box marginTop={1}>
          <Text bold>Decisions</Text>
        </Box>
        {decisions.length === 0 && <Text dimColor>none yet</Text>}
        {decisions.map(item => (
          <Text key={item.id} dimColor wrap="wrap">
            {'- '}
            {item.text}
          </Text>
        ))}

        {Input && (
          <Box marginTop={1}>
            <Input
              key="add"
              placeholder="add a task"
              submitLabel="add"
              onSubmit={async value => {
                const text = value.trim()
                if (!text) return
                const turn = await $.session.turns()
                const id = mintId(await $.clock.now())()
                await setItems($, list => [...list, { id, kind: 'task', text, status: 'open', turn, source: 'user' }])
              }}
            />
          </Box>
        )}

        <Box marginTop={1}>
          {state === 'thinking' && <Text dimColor>updating...</Text>}
          {state === 'error' && <Text color="red">{error}</Text>}
          {state === 'idle' && <Text dimColor>/task add, /go n send, /done n close</Text>}
        </Box>
      </Box>
    )
  })
}
