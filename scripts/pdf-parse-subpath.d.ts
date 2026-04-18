/**
 * Ambient declaration for the `pdf-parse/lib/pdf-parse.js` subpath import.
 *
 * We use the subpath to bypass pdf-parse's top-level `index.js`, which runs a
 * debug self-test that reads `./test/data/05-versions-space.pdf` at module load
 * time whenever it's imported under ESM or tsx (where `module.parent` is
 * falsy). The subpath entry is the plain library function with no self-test.
 *
 * @types/pdf-parse only ships types for the bare `'pdf-parse'` specifier, so
 * we re-export its signature here for the subpath.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    numpages: number
    numrender: number
    info: unknown
    metadata: unknown
    version: string
    text: string
  }
  interface PdfParseOptions {
    pagerender?: (pageData: unknown) => string
    max?: number
    version?: string
  }
  function pdfParse(dataBuffer: Buffer, options?: PdfParseOptions): Promise<PdfParseResult>
  export default pdfParse
}
