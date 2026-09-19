import { TraciveEnvironment } from '../model/TraciveEnvironment';

/**
 * Every path the SDK will ever request, in one place, so that a change to the API surface is a
 * one-file diff and an audit of what this package can reach is a one-file read.
 *
 * These paths are the agreed shape of the contract, and no test in this repository contacts a real
 * host.
 */
export const TRACIVE_API_PATHS = {
  scammerChecks: '/scammer-checks',
  credits: '/credits',
  profile: '/profile',
  token: '/oauth/token',
  revoke: '/oauth/revoke',
} as const;

export function apiUrl(environment: TraciveEnvironment, path: string): string {
  return `${TraciveEnvironment.baseUrl(environment)}${path}`;
}

/**
 * Phase 2. A partner gateway owns its own path space, so the SDK appends the same suffixes to
 * whatever base URL it was given rather than assuming a version segment.
 */
export function proxyUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`;
}

export function formUrlEncode(fields: readonly (readonly [string, string])[]): string {
  return fields
    .map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join('&');
}
