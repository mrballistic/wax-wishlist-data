import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { type UkList, UkListSchema, type UkOverrides, UkOverridesSchema } from '../types.js'

export const ukListPath = (repoRoot: string, seasonId: string): string =>
  resolve(repoRoot, 'releases', seasonId, 'uk.json')
export const ukOverridesPath = (repoRoot: string, seasonId: string): string =>
  resolve(repoRoot, 'releases', seasonId, 'uk-overrides.json')

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw err
  }
}

/** The season's parsed UK list, or null when it has none. */
export async function loadUkList(repoRoot: string, seasonId: string): Promise<UkList | null> {
  const raw = await readJson(ukListPath(repoRoot, seasonId))
  return raw === undefined ? null : UkListSchema.parse(raw)
}

/** The season's matcher overrides; empty when the file is absent. */
export async function loadUkOverrides(repoRoot: string, seasonId: string): Promise<UkOverrides> {
  return UkOverridesSchema.parse((await readJson(ukOverridesPath(repoRoot, seasonId))) ?? {})
}

export async function writeUkList(repoRoot: string, seasonId: string, list: UkList): Promise<void> {
  await writeFile(
    ukListPath(repoRoot, seasonId),
    `${JSON.stringify(UkListSchema.parse(list), null, 2)}\n`,
    'utf8',
  )
}
