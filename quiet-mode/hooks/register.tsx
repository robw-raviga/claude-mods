import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Chatter } from '../types'

// When a tool call starts, every reply drawn so far this turn is chatter: a newer
// message is on its way. Rows are known by the message id the engine draws them under.

const isOn = atom({ plugin: 'quiet-mode', key: 'isOn' } as const, true)
const chatter = atom({ plugin: 'quiet-mode', key: 'chatter' } as const, [] as Chatter)
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

// The app refuses its own drawing under a Box with `display`, so a hidden row is an empty Box.
const hide = ($: EngineInterface, e: RenderInput) => {
  const { Box } = $.ui.resolve(e)

  return <Box />
}

export const register: Register = on => {
  // A draw hook may not write state, so replies drawn this turn wait here until a tool call
  // marks them. Replies drawn outside a turn (earlier finals, a redraw after reload) are settled.
  let isTurnLive = false
  let drawnThisTurn = new Set<string>()
  const settled = new Set<string>()

  const settleTurn = () => {
    drawnThisTurn.forEach(id => settled.add(id))
    drawnThisTurn = new Set()
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'quiet',
      description: 'Quiet mode: hide tool calls and in-between chatter',
      argumentHint: '[on | off]',
    })
    await showStatus($, false)

    return next(e)
  })

  on('command.run', { command: 'quiet' }, async ($, e) => {
    const asked = e.args.trim().toLowerCase()
    await update($, isOn, wasOn => (asked === 'on' ? true : asked === 'off' ? false : !wasOn))
    await showStatus($, false)

    return { text: (await read($, isOn)) ? 'Quiet mode on.' : 'Quiet mode off.' }
  })

  on('prompt.submit', async ($, e, next) => {
    settleTurn()
    isTurnLive = true
    await update($, toolCount, () => 0)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const newlyChatter = [...drawnThisTurn]
    drawnThisTurn = new Set()
    if (newlyChatter.length > 0) {
      await update($, chatter, list => [...list, ...newlyChatter].slice(-MAX_CHATTER))
    }
    await update($, toolCount, n => n + 1)
    await showStatus($, true)

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      settleTurn()
      isTurnLive = false
      await showStatus($, false)
    }

    return next(e)
  })

  // Tool rows: hidden while quiet mode is on. The desktop already folds them into its own
  // "Ran N commands" summary, so there they pass through and the fold opens with content.
  for (const component of ['ToolUse', 'ToolResult', 'ToolGroup'] as const) {
    on('ui.render', { component }, async ($, e, next) => {
      if (e.surface === 'desktop' || !(await read($, isOn))) return next(e)

      return hide($, e)
    })
  }

  // Claude's text: hidden once a tool call follows it, so the latest reply always shows.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    if (!(await read($, chatter)).includes(e.requestId)) {
      if (!isTurnLive) settled.add(e.requestId)
      else if (!settled.has(e.requestId)) drawnThisTurn.add(e.requestId)

      return next(e)
    }

    return hide($, e)
  })
}
