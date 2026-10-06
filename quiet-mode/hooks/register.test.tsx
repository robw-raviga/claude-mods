import { expect, test } from 'claude-code/testing'

const SURFACES = ['terminal', 'desktop'] as const

const engineDraws = (on: Parameters<Parameters<typeof test>[1]>[1]) =>
  on('ui.render', $ => ({ type: 'Text', props: {}, children: ['engine'] }) as never)

test('tool rows draw as an empty box', async ($, on) => {
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
    expect(await ui.find({ text: /engine/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('the latest reply shows, chatter hides', async ($, on) => {
  engineDraws(on)
  on('session.messages', () => ({ value: [
    {
      role: 'assistant',
      text: 'Let me check the types first.',
      toolUses: [{ tool_use_id: 't1', tool: 'Read', input: {} }],
    },
  ] }) as never)
  on('tool.call', () => ({ result: {} }) as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 't1', file_path: '/tmp/x' } as never)
  for (const surface of SURFACES) {
    const reply = await $.ui.mount({
      plugin: 'quiet-mode',
      surface,
      component: 'AssistantMessage',
      props: { text: 'All done, here is the answer.', isFirstOfReply: true },
    })
    expect(await reply.find({ text: /engine/ })).toBeDefined()
    await reply.unmount()

    const chatter = await $.ui.mount({
      plugin: 'quiet-mode',
      surface,
      component: 'AssistantMessage',
      props: { text: 'Let me check the types first.', isFirstOfReply: true },
    })
    expect(await chatter.find({ text: /engine/ })).toBeUndefined()
    await chatter.unmount()
  }
})
