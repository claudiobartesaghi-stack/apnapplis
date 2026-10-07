export type Day = { input: number; output: number; cacheRead: number; cacheWrite: number; turns: number }
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'token-panel': { days: Record<string, Day>; limits: Limit[] }
  }
}
