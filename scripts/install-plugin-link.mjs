#!/usr/bin/env node
// DSH-P2M — idempotent local-link installer for the A-plugin (dsh-p2m)
//
// What it does (all on the DSH profile, NOT inside p2m's own dirs):
//   1. backs up <profile>/package.json once (package.json.bak-<ts>);
//   2. adds  "dsh-p2m": "link:<repo>"  to dependencies;
//   3. prepends "dsh-p2m" to dsh.profile.bundles so the A-plugin loads first
//      among third-party bundles (entry id stays `p2m`);
//   4. prints the exact next commands (pnpm install inside the profile).
//
// Safe by design: dry-run friendly, idempotent (no change -> no write, no
// backup), and it never deletes anything. Re-run any time to repair a
// partially edited profile.
//
// Usage:
//   node install-plugin-link.mjs [--profile-dir DIR] [--package-dir DIR]
// Defaults:
//   profile-dir = %USERPROFILE%\.dsh\profiles\web
//   package-dir = repository root (parent of scripts/)

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..')

function arg(name, fallback) {
  const idx = process.argv.indexOf(name)
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback
}

const profileDir = path.resolve(arg('--profile-dir', path.join(os.homedir(), '.dsh', 'profiles', 'web')))
const packageDir = path.resolve(arg('--package-dir', repoRoot))
const pkgFile = path.join(profileDir, 'package.json')
const linkValue = 'link:' + packageDir.replace(/\\/g, '/')
const NAME = 'dsh-p2m'

if (!fs.existsSync(pkgFile)) {
  console.error(`[install] profile package.json not found: ${pkgFile}`)
  process.exit(1)
}

const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
const actions = []

// 1) dependency
pkg.dependencies = pkg.dependencies || {}
if (pkg.dependencies[NAME] !== linkValue) {
  pkg.dependencies[NAME] = linkValue
  actions.push(`dependency "${NAME}" -> "${linkValue}"`)
}

// 2) bundle order: A-plugin mounts first among bundles
pkg.dsh = pkg.dsh || {}
pkg.dsh.profile = pkg.dsh.profile || {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || []
if (!pkg.dsh.profile.bundles.includes(NAME)) {
  pkg.dsh.profile.bundles.unshift(NAME)
  actions.push(`bundle "${NAME}" prepended to dsh.profile.bundles`)
}

if (!actions.length) {
  console.log('[install] already installed — nothing to change.')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const backup = `${pkgFile}.bak-${stamp}`
fs.copyFileSync(pkgFile, backup)
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n', 'utf8')

console.log('[install] profile package.json updated:')
for (const a of actions) console.log('   *', a)
console.log(`   * backup -> ${backup}`)
console.log()
console.log('Next steps (run in your own terminal, NOT inside a sandbox):')
console.log(`   1) cd /d "${profileDir}"`)
console.log('   2) pnpm install')
console.log('   3) start DSH via DSH-safe.cmd (or DSH.cmd)')
console.log()
console.log('Notes: entry id is `p2m` (do not change). State lands in')
console.log('      <DSH_HOME>/p2m/  (default ~/.dsh/p2m/).')
