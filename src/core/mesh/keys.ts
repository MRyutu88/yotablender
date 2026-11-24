// Undirected edges are identified by a numeric key built from their two vertex indices.
// Supports up to 4M vertices per mesh while staying an exact integer in a double.

export type Edge = [number, number];

const KEY_BASE = 4194304; // 2^22

export const edgeKey = (a: number, b: number): number => (a < b ? a * KEY_BASE + b : b * KEY_BASE + a);
export const dirKey = (a: number, b: number): number => a * KEY_BASE + b;
export const edgeFromKey = (k: number): Edge => [Math.floor(k / KEY_BASE), k % KEY_BASE];
