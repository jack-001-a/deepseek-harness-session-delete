#!/usr/bin/env node
/**
 * Deterministic, dependency-free syntax and metadata checks for the repository.
 *
 * Discovering source files avoids a hand-maintained npm script that silently
 * stops checking newly added tests or maintenance scripts.
 */
import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const sourceRoots = ['index.js', 'client.js', 'scripts', 'test']
const ignoredDirectories = new Set(['.git', 'node_modules', 'artifacts'])
const sourceExtensions = new Set(['.cjs', '.js', '.mjs'])
const files = []

function collect(path) {
  const entries = readdirSync(path, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoredDirectories.has(entry.name)) collect(join(path, entry.name))
      continue
    }
    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) {
      files.push(join(path, entry.name))
    }
  }
}

for (const entry of sourceRoots) {
  const path = join(root, entry)
  if (extname(entry)) files.push(path)
  else collect(path)
}
files.sort((left, right) => relative(root, left).localeCompare(relative(root, right)))

const failures = []
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    failures.push({
      file: relative(root, file),
      output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n').trim(),
    })
  }
}

for (const path of ['package.json', 'locale/en.json', 'locale/zh.json']) {
  try {
    JSON.parse(readFileSync(join(root, path), 'utf8'))
  } catch (error) {
    failures.push({
      file: path,
      output: error instanceof Error ? error.message : String(error),
    })
  }
}

if (failures.length > 0) {
  for (const failure of failures) {
    process.stderr.write(`\n[check] ${failure.file}\n${failure.output}\n`)
  }
  process.exitCode = 1
} else {
  process.stdout.write(`Syntax and JSON checks passed (${files.length} JavaScript files).\n`)
}
