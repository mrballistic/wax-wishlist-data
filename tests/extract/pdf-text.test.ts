import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { groundedFraction } from '../../scripts/extract/gate.js'
import { pdfTextLayer } from '../../scripts/extract/pdf-text.js'
import { parsePdf } from '../../scripts/parse-pdf.js'
import { REPO_ROOT } from '../helpers/releases.js'

describe('pdfTextLayer', () => {
  it.each(['2025-april', '2026-april', '2025-november'])(
    'contains ≥98%% of parser artists and titles for %s',
    async (name) => {
      const pdf = await readFile(join(REPO_ROOT, 'tests', 'fixtures', `${name}.pdf`))
      const text = await pdfTextLayer(pdf)
      const rows = await parsePdf(pdf)
      expect(groundedFraction(rows.map((r) => r.artist), text)).toBeGreaterThanOrEqual(0.98)
      expect(groundedFraction(rows.map((r) => r.title), text)).toBeGreaterThanOrEqual(0.98)
    },
  )
})
