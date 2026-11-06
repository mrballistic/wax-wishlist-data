import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { z } from 'zod'

import type { Release } from './types.js'

/**
 * `releases/<season>/discogs-overrides.json` (optional): hand fixes for the
 * Discogs lookup, keyed by release id.
 *
 * - `pin`: the release's master, full stop. Never looked up again.
 * - `reject`: masters that are known wrong for the release. A lookup that
 *   lands on one counts as a miss, so the release stays null until Discogs
 *   has a better match (the daily refresh keeps trying).
 *
 * A pin wins over a reject for the same release.
 */
export const DiscogsOverridesSchema = z
  .object({
    pin: z.record(z.number().int().positive()).default({}),
    reject: z.record(z.array(z.number().int().positive()).min(1)).default({}),
  })
  .strict()
export type DiscogsOverrides = z.infer<typeof DiscogsOverridesSchema>

export const DISCOGS_OVERRIDES_FILE = 'discogs-overrides.json'
export const NO_DISCOGS_OVERRIDES: DiscogsOverrides = { pin: {}, reject: {} }

/** The season's overrides; none when the file is absent. */
export async function loadDiscogsOverrides(repoRoot: string, seasonId: string): Promise<DiscogsOverrides> {
  let raw: string
  try {
    raw = await readFile(resolve(repoRoot, 'releases', seasonId, DISCOGS_OVERRIDES_FILE), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return NO_DISCOGS_OVERRIDES
    throw err
  }
  return DiscogsOverridesSchema.parse(JSON.parse(raw))
}

/** True when the release's id is pinned, so it must never be looked up. */
export const isPinned = (id: string, o: DiscogsOverrides): boolean => o.pin[id] !== undefined

/**
 * Apply the overrides: pinned releases get their pinned master, and a
 * rejected master becomes null. Run it before a lookup (so pinned releases
 * aren't searched and rejected ones are searched again) and after anything
 * that may restore an id, such as carrying the previous value forward.
 */
export function applyDiscogsOverrides<T extends Pick<Release, 'id' | 'discogsMasterId'>>(
  releases: T[],
  o: DiscogsOverrides,
): T[] {
  return releases.map((r) => {
    const pinned = o.pin[r.id]
    if (pinned !== undefined) return pinned === r.discogsMasterId ? r : { ...r, discogsMasterId: pinned }
    if (r.discogsMasterId !== null && o.reject[r.id]?.includes(r.discogsMasterId)) {
      return { ...r, discogsMasterId: null }
    }
    return r
  })
}
