export type ItemKind = 'task' | 'question' | 'decision'

export type Item = {
  id: string
  kind: ItemKind
  text: string
  status: 'open' | 'done'
  turn: number
  source: 'model' | 'user'
}

export type Activity = 'idle' | 'thinking' | 'error'

declare module 'claude-code' {
  interface PluginState {
    ledger: {
      items: Item[]
      activity: Activity
      lastError: string
    }
  }
}
