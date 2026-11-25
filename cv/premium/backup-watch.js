// 2026-11-25: the stub of the ITSaNAS backup watch (red).
export const BEHIND_AFTER_MS = 0;
export const STALE_AFTER_MS = 0;
export function readCopies() { return null; }
export function createBackupWatch() { return { check: () => ({}), status: () => ({}), idle: async () => {} }; }
