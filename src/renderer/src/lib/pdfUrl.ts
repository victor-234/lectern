/**
 * Where a PDF comes from, which is the one thing the two hosts genuinely can't
 * share a URL for.
 *
 * The desktop app registers a custom `lctrn-pdf://` scheme so Chromium's PDFium
 * viewer treats it like http(s) and renders it inside an <iframe> (see
 * `protocol.handle` in main/index.ts). A browser can't be given a new scheme, so
 * the server serves the same two shapes over `/pdf/…` instead. Both resolve the
 * file the same way — by paper id through the registry, or path-contained inside
 * a project — never from a caller-supplied absolute path.
 */

import { isBrowserHost } from './rpc'

const base = isBrowserHost ? '/pdf' : 'lctrn-pdf:/'

/** A library paper, by registry id. */
export function paperPdfUrl(id: string): string {
  return `${base}/paper/${encodeURIComponent(id)}`
}

/** A PDF inside a project (e.g. the rendered manuscript). */
export function projectPdfUrl(projectPath: string, name: string): string {
  return `${base}/project/${encodeURIComponent(projectPath)}/${encodeURIComponent(name)}`
}
