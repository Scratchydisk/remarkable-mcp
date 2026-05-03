#!/usr/bin/env node
/**
 * Non-interactive MCP server validator.
 *
 * Spawns the built server, drives it via stdio with a scripted JSON-RPC sequence, and asserts on
 * every response. Writes a transcript to validation-<version>.log.
 *
 * Covers the static-test path that Anthropic reviewers can run without a real reMarkable tablet:
 *   - initialize handshake
 *   - tools/list returns four tools, each with annotations populated
 *   - error-path validation (zod rejection of bad args, no stack traces)
 *   - remarkable_status with no tablet attached returns a clean diagnostic
 *
 * Usage:  npm run validate
 *
 * Exits non-zero on any failure so it's CI-safe.
 */
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SERVER = join(ROOT, 'dist', 'index.js');
const LOG_PATH = join(ROOT, `validation-${pkg.version}.log`);

if (!existsSync(SERVER)) {
  console.error(`Server build not found at ${SERVER}. Run \`npm run build\` first.`);
  process.exit(1);
}

const transcript = [];
const failures = [];

function record(role, payload) {
  const stamp = new Date().toISOString();
  const line = `[${stamp}] ${role} ${JSON.stringify(payload)}`;
  transcript.push(line);
}

function assert(cond, msg) {
  if (!cond) {
    failures.push(msg);
    transcript.push(`[ASSERT FAIL] ${msg}`);
  } else {
    transcript.push(`[OK]          ${msg}`);
  }
}

/**
 * Server harness: one stdout parser, one shared map of "what id are we still waiting for".
 * Each rpcSession() registers its expected ids, sends requests, then resolves when they all arrive.
 */
function startServer() {
  const proc = spawn('node', [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DEBUG: '' },
  });
  proc.stderr.on('data', (d) => transcript.push(`[stderr]      ${d.toString().trimEnd()}`));

  let buffer = '';
  /** @type {Map<number|string, (msg: unknown) => void>} */
  const pending = new Map();

  proc.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      record('<<', msg);
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });

  return {
    proc,
    /** Send requests; resolves with a Map of id → response once every id has replied. */
    rpcSession(requests) {
      return new Promise((resolve) => {
        const expectedIds = requests.filter((r) => r.id !== undefined).map((r) => r.id);
        const responses = new Map();
        if (expectedIds.length === 0) {
          for (const req of requests) {
            record('>>', req);
            proc.stdin.write(JSON.stringify(req) + '\n');
          }
          return resolve(responses);
        }
        let remaining = expectedIds.length;
        for (const id of expectedIds) {
          pending.set(id, (msg) => {
            responses.set(id, msg);
            if (--remaining === 0) resolve(responses);
          });
        }
        for (const req of requests) {
          record('>>', req);
          proc.stdin.write(JSON.stringify(req) + '\n');
        }
      });
    },
  };
}

async function main() {
  const { proc, rpcSession } = startServer();

  const initReq = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'validate-mcp', version: '0' } },
  };
  const initialised = { jsonrpc: '2.0', method: 'notifications/initialized' };
  const listReq = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

  const handshake = await rpcSession([initReq, initialised, listReq]);

  // ── initialize ──
  const initRes = handshake.get(1);
  assert(initRes?.result?.serverInfo?.name === 'remarkable-mcp', 'initialize: serverInfo.name is remarkable-mcp');
  assert(initRes?.result?.serverInfo?.version === pkg.version,    `initialize: serverInfo.version is ${pkg.version}`);
  assert(initRes?.result?.capabilities?.tools !== undefined,      'initialize: tools capability advertised');

  // ── tools/list ──
  const tools = handshake.get(2)?.result?.tools ?? [];
  const expectedNames = ['remarkable_setup', 'remarkable_list', 'remarkable_pull', 'remarkable_status', 'remarkable_search', 'remarkable_index'];
  for (const name of expectedNames) {
    const tool = tools.find((t) => t.name === name);
    assert(!!tool, `tools/list: ${name} present`);
    if (!tool) continue;
    assert(typeof tool.description === 'string' && tool.description.length > 20, `${name}: description is non-trivial`);
    assert(typeof tool.annotations?.title === 'string',                            `${name}: annotations.title set`);
    assert(typeof tool.annotations?.readOnlyHint === 'boolean',                    `${name}: annotations.readOnlyHint set`);
    assert(typeof tool.annotations?.destructiveHint === 'boolean',                 `${name}: annotations.destructiveHint set`);
    assert(typeof tool.annotations?.openWorldHint === 'boolean',                   `${name}: annotations.openWorldHint set`);
  }
  assert(tools.length === expectedNames.length, `tools/list: exactly ${expectedNames.length} tools (got ${tools.length})`);

  // ── error path: invalid args ──
  const badArgs = await rpcSession([{
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'remarkable_pull', arguments: { max_width: 'huge', format: 'gif' } },
  }]);
  const badRes = badArgs.get(3)?.result;
  assert(badRes?.isError === true,                                          'pull/bad-args: isError true');
  assert(typeof badRes?.content?.[0]?.text === 'string',                    'pull/bad-args: error text present');
  assert(/Invalid arguments/i.test(badRes?.content?.[0]?.text ?? ''),       'pull/bad-args: mentions "Invalid arguments"');
  assert(!/at\s+\w+\s+\(/.test(badRes?.content?.[0]?.text ?? ''),           'pull/bad-args: no stack trace leaked');

  // ── error path: inline_images=false without output_dir ──
  const noOut = await rpcSession([{
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'remarkable_pull', arguments: { inline_images: false } },
  }]);
  const noOutRes = noOut.get(4)?.result;
  assert(noOutRes?.isError === true,                                        'pull/no-output_dir: isError true');
  assert(/output_dir/.test(noOutRes?.content?.[0]?.text ?? ''),             'pull/no-output_dir: error names the missing field');

  // ── static-test path: status with no tablet ──
  const statusRes = await rpcSession([{
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'remarkable_status', arguments: {} },
  }]);
  const statusOut = statusRes.get(5)?.result;
  const statusText = statusOut?.content?.[0]?.text ?? '';
  assert(statusOut?.isError !== true,                                       'status/no-tablet: not an error response (clean diagnostic)');
  assert(statusText.startsWith(`remarkable-mcp v${pkg.version}`),           `status/no-tablet: includes version banner v${pkg.version}`);
  assert(/USB HTTP/.test(statusText),                                       'status/no-tablet: reports USB HTTP state');
  assert(/Host key/.test(statusText),                                       'status/no-tablet: reports host-key pinning state');
  assert(/Render/.test(statusText),                                         'status/no-tablet: reports render defaults');
  assert(!/Error:|TypeError/.test(statusText),                              'status/no-tablet: no error/exception strings leaked');

  proc.stdin.end();
  proc.kill();

  writeFileSync(LOG_PATH, transcript.join('\n') + '\n');
  console.log(`Transcript: ${LOG_PATH}`);

  const passed = transcript.filter((l) => l.startsWith('[OK]')).length;
  const failed = failures.length;
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('\nFailures:');
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  writeFileSync(LOG_PATH, transcript.join('\n') + `\n[FATAL] ${err.message}\n`);
  console.error(`Validation crashed: ${err.message}`);
  console.error(`Transcript: ${LOG_PATH}`);
  process.exit(1);
});
