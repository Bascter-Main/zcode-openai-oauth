// Entry shim for host/scheduler utility processes. bootstrap.mjs swaps the
// forked module for this file and passes the real entry via env.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

const configPath = process.env.ZCODE_RT_CONFIG;
const real = process.env.ZCODE_RT_REAL;

if (configPath) {
  try {
    register(new URL('./loader-hooks.mjs', import.meta.url), {
      parentURL: import.meta.url,
      data: { configPath },
    });
  } catch {}
}

if (real) {
  await import(pathToFileURL(real).href);
}
