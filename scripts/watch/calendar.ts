import { readFile } from 'node:fs/promises'

import { z } from 'zod'

/** Hand-maintained April RSD dates by year; RSD announces them months ahead. */
export const CalendarSchema = z.record(z.string().regex(/^\d{4}$/), z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
export type Calendar = z.infer<typeof CalendarSchema>

export async function loadCalendar(path: string): Promise<Calendar> {
  return CalendarSchema.parse(JSON.parse(await readFile(path, 'utf8')))
}

/** The day after the fourth Thursday of November (UTC date math). */
export function blackFridayDate(year: number): string {
  const novFirstDow = new Date(Date.UTC(year, 10, 1)).getUTCDay()
  const firstThursday = 1 + ((4 - novFirstDow + 7) % 7)
  const day = firstThursday + 21 + 1
  return `${year}-11-${String(day).padStart(2, '0')}`
}

/** Event date for `<year>-april` / `<year>-november`; null when unknown. */
export function seasonDate(seasonId: string, calendar: Calendar): string | null {
  const m = /^(\d{4})-(april|november)$/.exec(seasonId)
  if (!m) return null
  const [, year, kind] = m
  if (!year) return null
  if (kind === 'november') return blackFridayDate(Number(year))
  return calendar[year] ?? null
}
