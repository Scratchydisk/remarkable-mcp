#!/usr/bin/env node
/**
 * Build a single-click installable MCP Bundle (.mcpb) for Claude Desktop.
 *
 * Layout produced (zip contents):
 *   manifest.json          — bundle metadata (auto-generated from package.json)
 *   server/<built code>    — compiled output of `tsc` (dist/* → server/*)
 *   package.json           — stripped (deps only, main → server/index.js)
 *   node_modules/          — production deps only (npm install --omit=dev)
 *
 * Usage:  npm run mcpb
 *
 * Spec: https://github.com/anthropics/dxt/blob/main/MANIFEST.md
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const STAGING = join(ROOT, 'build', 'mcpb');
const OUTPUT = join(ROOT, `remarkable-mcp-${pkg.version}.mcpb`);
const OUTPUT_LATEST = join(ROOT, 'remarkable-mcp.mcpb');  // unversioned copy for `releases/latest/download/` URL

function run(cmd, args, opts = {}) {
  console.log(`> ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

console.log(`Building remarkable-mcp v${pkg.version} → ${OUTPUT}\n`);

// 1. Clean staging
rmSync(STAGING, { recursive: true, force: true });
mkdirSync(join(STAGING, 'server'), { recursive: true });

// 2. Compile (idempotent — picks up source changes)
run('npm', ['run', 'build'], { cwd: ROOT });
if (!existsSync(join(ROOT, 'dist', 'index.js'))) {
  throw new Error('build did not produce dist/index.js');
}

// 3. Copy built JS into server/
cpSync(join(ROOT, 'dist'), join(STAGING, 'server'), { recursive: true });

// 3b. Copy icon if present (manifest references it relative to the bundle root).
const iconSrc = join(ROOT, 'assets', 'icon.png');
const iconStaged = join(STAGING, 'icon.png');
let hasIcon = false;
if (existsSync(iconSrc)) {
  cpSync(iconSrc, iconStaged);
  hasIcon = true;
}

// 4. Stripped package.json (deps only — no devDeps, scripts, etc.)
const stagedPkg = {
  name: pkg.name,
  version: pkg.version,
  type: 'module',
  main: 'server/index.js',
  dependencies: pkg.dependencies,
};
writeFileSync(join(STAGING, 'package.json'), JSON.stringify(stagedPkg, null, 2));

// 5. Install production deps into the staging dir.
// NOTE: do NOT pass --omit=optional. Sharp ships platform-specific prebuilt binaries via optional
// dependencies; without them, JPEG rendering fails at runtime with MODULE_NOT_FOUND.
run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--silent'], {
  cwd: STAGING,
});

// 5b. Pull in sharp prebuilds for every platform we declare in `compatibility.platforms`.
// npm refuses to install packages whose package.json `os`/`cpu` fields don't match the host
// (even with --force / --os / --cpu, it silently no-ops). Workaround: `npm pack` each prebuild
// tarball and extract it directly into node_modules/@img/<name>/.
const sharpPkgPath = join(STAGING, 'node_modules', 'sharp', 'package.json');
const sharpPkg = JSON.parse(readFileSync(sharpPkgPath, 'utf8'));
const wantPlatforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'];
const prebuildPkgs = wantPlatforms.flatMap((plat) => {
  const out = [];
  const sharpDep = `@img/sharp-${plat}`;
  const libvipsDep = `@img/sharp-libvips-${plat}`;
  if (sharpPkg.optionalDependencies?.[sharpDep])  out.push({ name: sharpDep,   version: sharpPkg.optionalDependencies[sharpDep]  });
  if (sharpPkg.optionalDependencies?.[libvipsDep]) out.push({ name: libvipsDep, version: sharpPkg.optionalDependencies[libvipsDep] });
  return out;
});
const prebuildTmp = join(STAGING, '.prebuild-tmp');
mkdirSync(prebuildTmp, { recursive: true });
console.log(`Fetching ${prebuildPkgs.length} cross-platform sharp prebuilds…`);
for (const { name, version } of prebuildPkgs) {
  // `npm pack <name>@<ver>` writes a tarball to --pack-destination and prints its filename.
  const out = execFileSync('npm', ['pack', `${name}@${version}`, `--pack-destination=${prebuildTmp}`, '--silent'], {
    cwd: STAGING, encoding: 'utf8',
  }).trim();
  const tarball = out.split(/\s+/).pop();
  const targetDir = join(STAGING, 'node_modules', name);
  rmSync(targetDir, { recursive: true, force: true });
  mkdirSync(targetDir, { recursive: true });
  // Tarballs from `npm pack` have a top-level "package/" prefix; --strip-components=1 removes it.
  execFileSync('tar', ['xzf', join(prebuildTmp, tarball), '-C', targetDir, '--strip-components=1']);
}
rmSync(prebuildTmp, { recursive: true, force: true });

// 6. Generate the manifest
const manifest = {
  manifest_version: '0.3',
  name: 'remarkable-mcp',
  display_name: 'reMarkable Tablet',
  version: pkg.version,
  description: pkg.description,
  long_description:
    'Pull handwritten notes and diagrams from your reMarkable 2 tablet directly into any MCP-compatible AI agent. ' +
    'Connects via USB HTTP (fastest) or WiFi SSH; the WiFi path automatically falls back to mDNS (remarkable.local) ' +
    'when the saved DHCP lease has moved. Setup runs in two modes: full (with the on-tablet password — deploys ' +
    'an SSH key, enables the USB web interface, pins the host-key fingerprint) or refresh (no password — just ' +
    'rediscovers the current WiFi IP using the existing key). Documents are cached by mtime so repeat pulls are ' +
    'instant. Pages on a still-open document that the tablet hasn\'t flushed to disk are reported in the response. ' +
    'Renders PNG or JPEG via remarkable-rm (https://github.com/Scratchydisk/remarkable-rm) at a configurable ' +
    'width, with client-aware response sizing for Claude Desktop\'s ~1 MB ' +
    'tool-response cap. OCR via the host LLM (default), local Ollama, or Tesseract. Documents pulled in ollama ' +
    'or local OCR mode are added to a persistent BM25 search index (powered by MiniSearch) so you can ask ' +
    '"find my notes about X" across your whole library; remarkable_index bulk-OCRs everything in one shot. ' +
    'Connection failures include a categorised reason (timeout, refused, unreachable, auth failed, host-key ' +
    'mismatch) so the agent can suggest the right remedy.',
  author: {
    name: 'Stewart McSporran',
    url: 'https://github.com/Scratchydisk',
  },
  repository: {
    type: 'git',
    url: 'https://github.com/Scratchydisk/remarkable-mcp.git',
  },
  homepage: 'https://github.com/Scratchydisk/remarkable-mcp',
  documentation: 'https://github.com/Scratchydisk/remarkable-mcp#readme',
  support: 'https://github.com/Scratchydisk/remarkable-mcp/issues',
  ...(hasIcon ? { icon: 'icon.png' } : {}),
  license: pkg.license,
  keywords: ['remarkable', 'handwriting', 'ocr', 'notes', 'tablet', 'rm2'],
  server: {
    type: 'node',
    entry_point: 'server/index.js',
    mcp_config: {
      command: 'node',
      args: ['${__dirname}/server/index.js'],
    },
  },
  // Per-tool titles are exposed at runtime via `tools/list` annotations (see src/tools/*.ts).
  tools: [
    { name: 'remarkable_setup',  description: 'Configure tablet access. With password: full setup (deploys SSH key, enables USB web interface, pins host key). Without password: refresh mode (rediscovers WiFi IP using existing key).' },
    { name: 'remarkable_list',   description: 'List documents on the tablet, sorted by most recently modified. Folder filter supported.' },
    { name: 'remarkable_pull',   description: 'Pull a document and return rendered page images (PNG or JPEG). Cached by mtime; reports unflushed pages.' },
    { name: 'remarkable_status', description: 'Report connectivity (USB, WiFi, mDNS), firmware version, host-key pinning state, and configuration paths with categorised error reasons.' },
    { name: 'remarkable_search', description: 'Full-text search across the OCR\'d contents of cached documents. Ranked, fuzzy + prefix matching, returns page-level hits with snippets.' },
    { name: 'remarkable_index',  description: 'Bulk-OCR every document on the tablet and add it to the search corpus. Requires ocr.provider="ollama" or "local" in config.' },
    { name: 'remarkable_save_transcription', description: 'Save text the agent transcribed from a previous remarkable_pull into the cache and search index. Bridges native OCR mode (host LLM reads images) into the search corpus.' },
  ],
  compatibility: {
    claude_desktop: '>=0.10.0',
    platforms: ['darwin', 'win32', 'linux'],
    runtimes: { node: '>=20' },
  },
};
writeFileSync(join(STAGING, 'manifest.json'), JSON.stringify(manifest, null, 2));

// 7. Validate + pack
run('npx', ['-y', '@anthropic-ai/mcpb', 'validate', join(STAGING, 'manifest.json')]);
rmSync(OUTPUT, { force: true });
run('npx', ['-y', '@anthropic-ai/mcpb', 'pack', STAGING, OUTPUT]);

// 8. Mirror the versioned tarball as `remarkable-mcp.mcpb` so the GitHub Releases
//    `latest/download/<filename>` URL stays stable across version bumps.
copyFileSync(OUTPUT, OUTPUT_LATEST);

console.log(`\n✓ Built ${OUTPUT}`);
console.log(`  Mirrored to ${OUTPUT_LATEST}`);
