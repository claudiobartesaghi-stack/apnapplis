import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Day, Limit } from '../types'

const PANE = 'panel-consumi'
const days = atom({ plugin: 'panel-consumi', key: 'days' } as const, {})
const limits = atom({ plugin: 'panel-consumi', key: 'limits' } as const, [])

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
      name: 'panel-consumi',
      description: 'Pannello dei consumi token giornalieri e settimanali',
    })
    const saved = (await $.store.get('days')) as Record<string, Day> | undefined
    await update($, days, () => saved ?? {})

    return next(e)
  })

  // Il riepilogo va anche come testo: si legge dove il pannello non si vede.
  on('command.run', { command: 'panel-consumi' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: 'Consumi' })
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
      `${title}: ${fmt(d.input + d.output)} token (ingresso ${fmt(d.input)}, uscita ${fmt(d.output)}), cache ${fmt(d.cacheRead + d.cacheWrite)}, ${d.turns} ${d.turns === 1 ? 'turno' : 'turni'}`

    const day = sumOf(1)
    const week = sumOf(7)
    const share = total(week) > 0 ? (total(day) / total(week)) * 100 : 0

    const head = opened.isPlaced
      ? 'Consumi (pannello aperto)'
      : `Consumi (pannello non mostrato: ${opened.reason ?? 'motivo non indicato'})`
    const limitLines = windows.length
      ? windows.map(w => `  ${label(w.kind)}: ${w.percentUsed.toFixed(1)}%`)
      : ["  Limiti dell'account: nessun dato (serve un abbonamento e una risposta API)."]

    return {
      text: [
        head,
        '',
        'Percentuali',
        ...limitLines,
        `  Oggi: ${share.toFixed(0)}% dei token degli ultimi 7 giorni`,
        '',
        'Numeri',
        `  ${line('Oggi', day)}`,
        `  ${line('Ultimi 7 giorni', week)}`,
      ].join('\n'),
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
        const next30 = Object.fromEntries(kept.map(k => [k, cur[k] ?? EMPTY]))
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

  // Barra sempre visibile sopra il prompt: si ridisegna da sola quando cambiano i valori.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) {
      return next(e)
    }

    const { Box, Text } = $.ui.resolve(e)
    const byDay = await read($, days)
    const windows = await read($, limits)
    const now = await $.clock.now()

    const sumOf = (n: number) => {
      let io = 0
      let cache = 0
      for (let i = 0; i < n; i++) {
        const d = byDay[dayKey(now - i * 864e5)] ?? EMPTY
        io += d.input + d.output
        cache += d.cacheRead + d.cacheWrite
      }
      return { io, cache }
    }
    const day = sumOf(1)
    const week = sumOf(7)
    const find = (kind: string) => windows.find(w => w.kind === kind)
    const tone = (p: number) => (p >= 90 ? 'error' : p >= 70 ? 'warning' : 'success')
    const meter = (title: string, kind: string) => {
      const w = find(kind)

      return w ? (
        <Text>
          {title} <Text color={tone(w.percentUsed)}>{bar(w.percentUsed, 12)}</Text> {Math.round(w.percentUsed)}%
        </Text>
      ) : (
        <Text dimColor>{title} {bar(0, 12)} n.d.</Text>
      )
    }

    return (
      <Box flexDirection="column">
        <Box gap={3}>
          {meter('Sessione 5 ore', 'five_hour')}
          {meter('Settimana', 'seven_day')}
        </Box>
        <Text dimColor>
          Oggi {fmt(day.io)} token (cache {fmt(day.cache)}) · 7 giorni {fmt(week.io)} (cache {fmt(week.cache)})
        </Text>
      </Box>
    )
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
