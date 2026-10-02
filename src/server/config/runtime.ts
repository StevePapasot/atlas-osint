/**
 * Minimum Node.js version. Two dependencies set the floor:
 *  - better-sqlite3 13 segfaults (no error message) when opening a database on Node 22 releases before 22.14;
 *  - undici 8 (outbound HTTP for providers) requires Node 22.19+.
 */
export const MIN_NODE_VERSION = '22.19.0';

function parse(v: string): [number, number, number] {
  const [a = 0, b = 0, c = 0] = v.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [a, b, c];
}

/** Returns a human-readable problem when `version` is older than the supported minimum, else null. */
export function nodeVersionProblem(version: string = process.versions.node): string | null {
  const have = parse(version);
  const need = parse(MIN_NODE_VERSION);
  for (let i = 0; i < 3; i++) {
    if (have[i]! > need[i]!) return null;
    if (have[i]! < need[i]!) {
      return (
        `ATLAS needs Node.js ${MIN_NODE_VERSION} or newer, but this is Node.js ${version}. ` +
        'Older Node 22 releases make the SQLite driver crash without any error message. ' +
        'Install the current LTS version from https://nodejs.org, close and reopen your terminal, check `node -v`, ' +
        'and run the command again.'
      );
    }
  }
  return null;
}

/** Throws before any native module is loaded on an unsupported Node.js version. */
export function assertSupportedNode(): void {
  const problem = nodeVersionProblem();
  if (problem) throw new Error(problem);
}
