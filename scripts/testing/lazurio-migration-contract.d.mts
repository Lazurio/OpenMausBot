export function engineInvocation(codex: boolean, args: readonly string[]): string;
export function migrationFetch(record: (kind: string) => void, healthFetch?: typeof globalThis.fetch): typeof globalThis.fetch;
export function migrationDiagnostic(error: unknown, phase: string): { phase: string; code: string };
export function validModelCache(cache: unknown): boolean;
