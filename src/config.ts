/**
 * Configuration, read once at startup.
 *
 * The secret key is server-side only. It must never reach the browser — the publishable
 * key is the one the frontend gets. Nothing here is ever logged.
 */

import { readFileSync } from 'node:fs';

export type Config = {
  pravaBaseUrl: string;
  pravaSecretKey: string;
  duffelBaseUrl: string;
  duffelApiKey: string;
};

/**
 * Reads `.env.local` directly rather than depending on dotenv.
 *
 * NOTE the encoding: files written by PowerShell on this machine carry a UTF-8 BOM, which
 * turns the first key into `﻿KEY` and produces a baffling "undefined env var" for a
 * line that is plainly present. `utf8` + explicit BOM strip avoids that.
 */
export function loadEnvFile(path = '.env.local'): Record<string, string> {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return {};
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);

  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key) out[key] = value;
  }
  return out;
}

export function loadConfig(path?: string): Config {
  const file = loadEnvFile(path);
  const get = (key: string): string => {
    const value = process.env[key] ?? file[key];
    if (!value) throw new Error(`Missing required configuration: ${key}`);
    return value;
  };

  return {
    // Sandbox is a different HOST, not a path prefix on the production one.
    pravaBaseUrl: process.env['PRAVA_BASE_URL'] ?? file['PRAVA_BASE_URL'] ?? 'https://sandbox.api.prava.space',
    pravaSecretKey: get('MERCHANT_SECRET_KEY'),
    duffelBaseUrl: process.env['DUFFEL_BASE_URL'] ?? file['DUFFEL_BASE_URL'] ?? 'https://api.duffel.com',
    duffelApiKey: get('DUFFEL_API_KEY'),
  };
}
