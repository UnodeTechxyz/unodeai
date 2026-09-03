#!/usr/bin/env node
/*
 * T2 is deliberately narrow. This gate does not try to prove all tool prose is "honest"; it pins the
 * two consequential semantic boundaries that previously caused real incorrect action: anonymous web
 * fetches and the native shell dialect. The source description remains human-audited for every other
 * tool surface.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const FIXED_FETCH_DESCRIPTION = "Fetch an anonymous public http/https URL and return its text content. This tool carries none of the user's configured credentials or identity, so it cannot test an endpoint that requires authentication. Private/internal addresses are rejected. HTML tags are stripped; JSON is returned as-is. Output is truncated to 100,000 characters.";
export const PRE_V0946_FETCH_DESCRIPTION = 'Fetch a public http/https web page or API URL and return its text content. HTML tags are stripped; JSON is returned as-is. Output is truncated to 100,000 characters.';

/** Returns named, mechanical failures so CI tells the author exactly which boundary disappeared. */
export function checkToolDescriptions(source) {
  const failures = [];
  const fetchStart = source.indexOf("name: 'fetch_url'");
  const fetchEnd = source.indexOf("fn('search_files'", fetchStart);
  const fetch = fetchStart >= 0 && fetchEnd > fetchStart ? source.slice(fetchStart, fetchEnd) : '';
  if (!fetch) {
    failures.push('fetch_url: tool declaration was not found.');
  } else {
    for (const [label, pattern] of [
      ['anonymous identity', /anonymous/i],
      ['no configured credentials', /configured credentials/i],
      ['authentication limitation', /cannot test an endpoint that requires authentication/i],
    ]) {
      if (!pattern.test(fetch)) {
        failures.push(`fetch_url: missing ${label} boundary.`);
      }
    }
  }

  const commandStart = source.indexOf("fn('run_command'");
  const commandEnd = source.indexOf("fn('check_command'", commandStart);
  const command = commandStart >= 0 && commandEnd > commandStart ? source.slice(commandStart, commandEnd) : '';
  if (!/subject to command approval/i.test(command) || !/cmd\.exe syntax on Windows/i.test(command)) {
    failures.push('run_command: missing approval or Windows shell-dialect boundary.');
  }
  return failures;
}

async function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const sourcePath = path.join(root, 'src', 'backend', 'WorkspaceTools.ts');
  const source = await readFile(sourcePath, 'utf8');
  const failures = checkToolDescriptions(source);
  if (process.argv.includes('--mutation-test')) {
    const start = source.indexOf("description: 'Fetch an anonymous", source.indexOf("name: 'fetch_url'"));
    const end = source.indexOf(',\n            parameters:', start);
    const restored = start >= 0 && end > start
      ? source.slice(0, start) + `description: '${PRE_V0946_FETCH_DESCRIPTION}'` + source.slice(end)
      : source;
    const mutationFailures = checkToolDescriptions(restored);
    if (restored === source || !mutationFailures.some((failure) => failure.startsWith('fetch_url:'))) {
      throw new Error('fetch_url pre-v0.9.46 description mutation did not fail the named description gate.');
    }
    console.log('PASS: fetch_url pre-v0.9.46 description mutation is rejected by name.');
  }
  if (failures.length > 0) {
    throw new Error(`Tool description gate failed:\n- ${failures.join('\n- ')}`);
  }
  console.log('Tool description gate passed.');
}

if (process.argv[1]?.endsWith('check-tool-descriptions.mjs')) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
