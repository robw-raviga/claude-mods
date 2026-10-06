import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

// Hidden rows draw an empty Box; shown ones carry the app's own drawing.
const isHidden = async (ui: { drawn: () => Promise<unknown> }) => {
  const drawn = (await ui.drawn()) as { type: string; children?: unknown[] }

  return drawn.type === 'Box' && (drawn.children ?? []).length === 0
}

// Stands in for the app: answers with a real engine node, so the app's own rules about where
// engine nodes may sit apply here too.
const engineDraws = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)

test('tool rows hide on the terminal and pass through to the desktop fold', async ($, on) => {
  engineDraws(on)
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({
      plugin: 'quiet-mode',
      surface,
      component: 'ToolUse',
      props: {
        tool_use_id: 't1',
        tool: 'Bash',
        input: { command: 'ls' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
      },
    })
    expect(await isHidden(ui)).toBe(surface === 'terminal')
    await ui.unmount()
  }
})

test('a reply followed by a tool call hides, the latest reply shows', async ($, on) => {
  engineDraws(on)
  on('tool.call', () => ({ result: {} }) as never)
  on('prompt.submit', ($, e) => e as never)
  for (const surface of SURFACES) {
    await $.prompt.submit({ text: 'go' } as never)
    const reply = (requestId: string, text: string) =>
      $.ui.mount({
        plugin: 'quiet-mode',
        surface,
        component: 'AssistantMessage',
        requestId: `${surface}-${requestId}`,
        props: { text, isFirstOfReply: true },
      })

    const narration = await reply('m1', 'Let me check the types first.')
    expect(await isHidden(narration)).toBe(false)

    await $.tool.call({ tool: 'Read', tool_use_id: `${surface}-t1`, file_path: '/tmp/x' } as never)
    expect(await isHidden(narration)).toBe(true)

    const final = await reply('m2', 'All done, here is the answer.')
    expect(await isHidden(final)).toBe(false)

    await narration.unmount()
    await final.unmount()
  }
})

test('/quiet on and off set the mode, bare /quiet toggles', async ($, on) => {
  const run = async (args: string) =>
    ((await $.command.run({ command: 'quiet', args } as never)) as { text?: string }).text

  expect(await run('off')).toBe('Quiet mode off.')
  expect(await run('off')).toBe('Quiet mode off.')
  expect(await run('on')).toBe('Quiet mode on.')
  expect(await run('on')).toBe('Quiet mode on.')
  expect(await run('')).toBe('Quiet mode off.')
})
