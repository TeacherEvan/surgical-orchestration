/**
 * Unified file classification for the Code Reviewer layer.
 *
 * Single source of truth for FRONTEND/BACKEND/AMBIGUOUS lane routing.
 * Heuristics cover both mid-path (`/components/`) and path-start (`components/`)
 * forms, and dual-signal files default to AMBIGUOUS so both lanes review them.
 */

export type FileLane = 'FRONTEND' | 'BACKEND' | 'AMBIGUOUS';

export interface ChangedFile {
  path: string;
}

/**
 * Buckets a single changed file path into a review lane.
 */
export function defaultClassifyFile(filePath: string): FileLane {
  const lower = filePath.toLowerCase();
  const isFrontend =
    /\.(tsx|jsx|vue|svelte|css|html|scss|sass|less)$/.test(lower) ||
    /(^|\/)components(\/|$)/.test(lower) ||
    /(^|\/)ui(\/|$)/.test(lower) ||
    /(^|\/)frontend(\/|$)/.test(lower);
  const isBackend =
    /\.(py|go|rs|java|rb|php|sql|prisma|c|cpp|cs)$/.test(lower) ||
    /(^|\/)api(\/|$)/.test(lower) ||
    /(^|\/)server(\/|$)/.test(lower) ||
    /(^|\/)backend(\/|$)/.test(lower) ||
    /(^|\/)services(\/|$)/.test(lower) ||
    /(^|\/)convex(\/|$)/.test(lower);

  if (isFrontend && isBackend) return 'AMBIGUOUS';
  if (isFrontend) return 'FRONTEND';
  if (isBackend) return 'BACKEND';
  return 'AMBIGUOUS';
}
