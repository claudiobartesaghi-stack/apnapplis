import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Day, Limit } from '../types'

const PANE = 'token-panel'
const days = atom({ plugin: 'token-panel', key: 'days' } as const, {})
const limits = atom({ plugin: 'token-panel', key: 'limits' } as const, [])

const EMPTY: Day = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 }
const total = (d: Day) => d.input + d.output + d.cacheRead + d.cacheWrite
const fmt = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`
const dayKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const bar = (pct: number, width = 20) => {
  const filled = Math.round((Math.min(100, Math.max(0, pct)) / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}
const label = (kind: string) =>
  kind === 'five_hour' ? 'Finestra 5 ore' : kind === 'seven_day' ? 'Finestra 7 giorni' : kind

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'token-panel',
      description: 'Pannello dei consumi token giornalieri e settimanali',
    })
    const saved = (await $.store.get('days')) as Record<string, Day> | undefined
    await update($, days, () => saved ?? {})

    return next(e)
  })

  // Il riepilogo va anche come testo: si legge dove il pannello non si vede.
  on('command.run', { command: 'token-panel' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Consumi token' })
    const byDay = await read($, days)
    const windows = await read($, limits)
    const now = await $.clock.now()

    const sumOf = (n: number): Day => {
      const acc = { ...EMPTY }
      for (let i = 0; i < n; i++) {
        const d = byDay[dayKey(now - i * 864e5)] ?? EMPTY
        acc.input += d.input
        acc.output += d.output
        acc.cacheRead += d.cacheRead
        acc.cacheWrite += d.cacheWrite
        acc.turns += d.turns
      }
      return acc
    }
    const line = (title: string, d: Day) =>
      `${title}: ${fmt(total(d))} token (ingresso ${fmt(d.input)}, uscita ${fmt(d.output)}, cache ${fmt(d.cacheRead + d.cacheWrite)}), ${d.turns} turni`

    const head = opened.isPlaced
      ? 'Pannello consumi token aperto.'
      : `Pannello non mostrato (${opened.reason ?? 'motivo non indicato'}). Riepilogo:`
    const limitLines = windows.length
      ? windows.map(w => `${label(w.kind)}: ${w.percentUsed.toFixed(1)}%`)
      : ["Limiti dell'account: nessun dato (serve un abbonamento e una risposta API)."]

    return {
      text: [head, line('Oggi', sumOf(1)), line('Ultimi 7 giorni', sumOf(7)), ...limitLines].join('\n'),
    }
  })

  // Token reali di ogni turno, sommati per giorno e salvati tra le sessioni.
  on('turn.complete', async ($, e, next) => {
    if (e.usage && e.agentId === undefined) {
      const key = dayKey(await $.clock.now())
      const u = e.usage
      const all = await update($, days, cur => {
        const d = cur[key] ?? EMPTY
        const kept = Object.keys(cur).sort().slice(-30)
        const next30 = Object.fromEntries(kept.map(k => [k, cur[k]]))
        next30[key] = {
          input: d.input + u.input_tokens,
          output: d.output + u.output_tokens,
          cacheRead: d.cacheRead + u.cache_read_input_tokens,
          cacheWrite: d.cacheWrite + u.cache_creation_input_tokens,
          turns: d.turns + 1,
        }
        return next30
      })
      await $.store.set('days', all)
    }

    return next(e)
  })

  // Percentuali ufficiali dei limiti dell'account (solo con abbonamento).
  on('session.measure', async ($, e, next) => {
    await update($, limits, () => e.rateLimits as Limit[])

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const byDay = await read($, days)
    const windows = await read($, limits)
    const now = await $.clock.now()

    const today = byDay[dayKey(now)] ?? EMPTY
    const last7 = Array.from({ length: 7 }, (_, i) => dayKey(now - i * 864e5))
    const week = last7.reduce(
      (acc, k) => {
        const d = byDay[k] ?? EMPTY
        return {
          input: acc.input + d.input,
          output: acc.output + d.output,
          cacheRead: acc.cacheRead + d.cacheRead,
          cacheWrite: acc.cacheWrite + d.cacheWrite,
          turns: acc.turns + d.turns,
        }
      },
      { ...EMPTY },
    )
    const share = total(week) > 0 ? (total(today) / total(week)) * 100 : 0

    const block = (title: string, d: Day) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>{title}</Text>
        <Text>Totale   {fmt(total(d))}   ({d.turns} turni)</Text>
        <Text dimColor>Ingresso {fmt(d.input)}</Text>
        <Text dimColor>Uscita   {fmt(d.output)}</Text>
        <Text dimColor>Cache lettura {fmt(d.cacheRead)}   Cache scrittura {fmt(d.cacheWrite)}</Text>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {block('Oggi', today)}
        <Text dimColor>Oggi = {share.toFixed(0)}% del totale degli ultimi 7 giorni</Text>
        <Text>{bar(share)} {share.toFixed(0)}%</Text>
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          {block('Ultimi 7 giorni', week)}
        </Box>
        <Text bold>Limiti dell'account</Text>
        {windows.length === 0 && <Text dimColor>Nessun dato (serve un abbonamento e una risposta API).</Text>}
        {windows.map(w => (
          <Box flexDirection="column">
            <Text>{label(w.kind)}: {w.percentUsed.toFixed(1)}%</Text>
            <Text>{bar(w.percentUsed)}</Text>
            {w.resetsAt && <Text dimColor>reset {new Date(w.resetsAt).toLocaleString()}</Text>}
          </Box>
        ))}
      </Box>
    )
  })
}

// ricarica richiesta
