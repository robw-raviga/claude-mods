export type Chatter = string[]

declare module 'claude-code' {
  interface PluginState {
    'quiet-mode': {
      isOn: boolean
      chatter: Chatter
      toolCount: number
    }
  }
}
