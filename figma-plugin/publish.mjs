#!/usr/bin/env node
// Copies the freshly compiled .build/code.js over code.js only when its content differs. Figma reloads a
// development plugin as soon as its code.js changes on disk, which cuts off any call in progress, so a
// build with nothing new must leave the file (and its timestamp) alone.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Writes `from` over `to` if they differ. Returns true when `to` was (re)written. */
export function publish(from, to) {
  const fresh = readFileSync(from, 'utf8');
  if (existsSync(to) && readFileSync(to, 'utf8') === fresh) return false;
  writeFileSync(to, fresh);
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const here = dirname(fileURLToPath(import.meta.url));
  const changed = publish(join(here, '.build', 'code.js'), join(here, 'code.js'));
  console.log(
    changed
      ? 'code.js updated: Figma reloads every open copy of the plugin.'
      : 'code.js unchanged: open plugins keep running.',
  );
}
