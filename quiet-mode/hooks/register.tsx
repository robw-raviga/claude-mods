import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chatter } from '../types'

// A reply counts as chatter once the message it sits in also made a tool call.
// We remember those texts and hide any assistant block whose text is one of them.

const isOn = atom({ plugin: 'quiet-mode', key: 'isOn' } as const, true)
const chatter = atom({ plugin: 'quiet-mode', key: 'chatter' } as const, [])
const toolCount = atom({ plugin: 'quiet-mode', key: 'toolCount' } as const, 0)

const MAX_CHATTER = 500

const showStatus = async ($: EngineInterface, isWorking: boolean) => {
  if (!(await read($, isOn))) return $.ui.status(undefined)

  const count = await read($, toolCount)
  const plural = count === 1 ? '' : 's'
  $.ui.status(
    isWorking
      ? `${count} tool${plural} so far`
      : `${count} tool${plural} hidden`,
  )
}

const chatterTextFor = async ($: EngineInterface, toolUseId: string) => {
  const messages = await $.session.messages()
  const owner = messages.findLast(
    m => m.role === 'assistant' && m.toolUses.some(t => t.tool_use_id === toolUseId),
  )

  return owner?.text.trim() ?? ''
}

const isChatter = (list: Chatter, text: string) => {
  const block = text.trim()

  return block !== '' && list.some(full => full.includes(block))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quiet',
      description: 'Toggle quiet mode: hide tool calls and in-between chatter',
    })
    await showStatus($, false)

    return next(e)
  })

  on('command.run', { command: 'quiet' }, async $ => {
    await update($, isOn, wasOn => !wasOn)
    await showStatus($, false)

    return { text: (await read($, isOn)) ? 'Quiet mode on.' : 'Quiet mode off.' }
  })

  on('prompt.submit', async ($, e, next) => {
    await update($, toolCount, () => 0)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const text = await chatterTextFor($, e.tool_use_id)
    if (text !== '') {
      await update($, chatter, list =>
        list.includes(text) ? list : [...list, text].slice(-MAX_CHATTER),
      )
    }
    await update($, toolCount, n => n + 1)
    await showStatus($, true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await showStatus($, false)

    return next(e)
  })

  // Tool rows: hidden whole while quiet mode is on.
  for (const component of ['ToolUse', 'ToolResult', 'ToolGroup'] as const) {
    on('ui.render', { component }, async ($, e, next) => {
      if (!(await read($, isOn))) return next(e)

      const { Box } = $.ui.resolve(e)

      return <Box />
    })
  }

  // Claude's text: hidden once it turns out to be chatter, so the latest reply always shows.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (!isChatter(await read($, chatter), e.props.text)) return next(e)

    const { Box } = $.ui.resolve(e)

    return <Box />
  })
}
