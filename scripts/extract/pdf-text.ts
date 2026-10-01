import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { TextItem } from 'pdfjs-dist/types/src/display/api.js'

/**
 * The PDF's text layer as one string (text items joined by spaces). The gate
 * checks LLM output against it so a model can't publish rows the PDF doesn't
 * contain.
 */
export async function pdfTextLayer(pdf: Buffer): Promise<string> {
  const doc = await getDocument({ data: new Uint8Array(pdf), verbosity: 0 }).promise
  const parts: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    for (const item of content.items.filter((it): it is TextItem => 'str' in it)) {
      parts.push(item.str)
    }
  }
  return parts.join(' ')
}
