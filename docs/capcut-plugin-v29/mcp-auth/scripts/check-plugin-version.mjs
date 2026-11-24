#!/usr/bin/env node
/**
 * Checks the loaded CapCut plugin against the hosted installation skill.
 * Read-only: never runs the remote instructions, changes plugins, or starts OAuth.
 * Usage: node <installed-skill>/scripts/check-plugin-version.mjs
 */

import fs from 'node:fs/promises'
import https from 'node:https'

const INSTALL_SKILL_URL = 'https://sf16-sg.tiktokcdn.com/obj/eden-sg/962370eh7nupenuhbo/capcut_codex_plugin/SKILL.md'
const MANIFEST_URL = new URL('../../../.codex-plugin/plugin.json', import.meta.url)
const MAX_SKILL_BYTES = 256 * 1024

/** Parses strict semantic versions without losing precision on numeric identifiers. */
function parseVersion(value) {
  if (typeof value !== 'string') throw new Error('invalid_plugin_version')
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value)
  if (!match) throw new Error('invalid_plugin_version')
  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
    throw new Error('invalid_plugin_version')
  }
  return { core: match.slice(1, 4).map((part) => BigInt(part)), prerelease }
}

/** Compares semantic-version precedence; build metadata never requests an upgrade. */
function compareVersions(current, latest) {
  const left = parseVersion(current)
  const right = parseVersion(latest)
  for (let index = 0; index < 3; index++) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1
  }
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index++) {
    const a = left.prerelease[index]
    const b = right.prerelease[index]
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1
    if (a === b) continue
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) return BigInt(a) < BigInt(b) ? -1 : 1
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    return a < b ? -1 : 1
  }
  return 0
}

/** Reads only the explicitly advertised metadata.plugin-version from YAML frontmatter. */
function installationVersion(document) {
  const frontmatter = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(document)
  if (!frontmatter) throw new Error('installation_skill_version_missing')
  const lines = frontmatter[1].split(/\r?\n/)
  let inMetadata = false
  const versions = []
  let metadataCount = 0
  for (const line of lines) {
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true
      metadataCount++
    } else if (/^\S/.test(line) && !line.startsWith('#')) {
      inMetadata = false
    } else if (inMetadata) {
      const field = /^  plugin-version:\s*(.*?)\s*$/.exec(line)
      if (field) {
        const scalar = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s#'"\r\n]+))(?:\s+#.*)?$/.exec(field[1])
        if (!scalar) throw new Error('installation_skill_version_invalid')
        versions.push(scalar[1] || scalar[2] || scalar[3])
      }
    }
  }
  if (!versions.length) throw new Error('installation_skill_version_missing')
  if (metadataCount !== 1 || versions.length !== 1) throw new Error('installation_skill_version_invalid')
  parseVersion(versions[0])
  return versions[0]
}

/** Fetches the fixed public document with a total timeout and bounded memory use. */
function fetchInstallationSkill() {
  return new Promise((resolve, reject) => {
    let timer
    const request = https.get(INSTALL_SKILL_URL, { headers: { Accept: 'text/plain', 'Cache-Control': 'no-cache' } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        request.destroy(new Error('installation_skill_unavailable'))
        return
      }
      const chunks = []
      let size = 0
      response.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_SKILL_BYTES) {
          request.destroy(new Error('installation_skill_too_large'))
          return
        }
        chunks.push(chunk)
      })
      response.on('end', () => {
        clearTimeout(timer)
        resolve(Buffer.concat(chunks).toString('utf8'))
      })
      response.on('error', () => {
        clearTimeout(timer)
        reject(new Error('installation_skill_unavailable'))
      })
    })
    request.on('error', () => {
      clearTimeout(timer)
      reject(new Error('installation_skill_unavailable'))
    })
    timer = setTimeout(() => request.destroy(new Error('installation_skill_timeout')), 10000)
  })
}

/** Emits a comparison result without interpreting remote instructions or touching login state. */
async function main() {
  const output = { event: 'plugin_version_check', installation_skill_url: INSTALL_SKILL_URL }
  try {
    const manifest = JSON.parse(await fs.readFile(MANIFEST_URL, 'utf8'))
    // 同时识别当前清单名称和历史包名称，保持旧包的升级检查可用。
    if (manifest.name !== 'capcut' && manifest.name !== 'CapCut') throw new Error('installed_plugin_manifest_invalid')
    parseVersion(manifest.version)
    output.current_version = manifest.version
  } catch {
    process.stdout.write(`${JSON.stringify({ ...output, status: 'unknown', reason: 'installed_plugin_version_unavailable' })}\n`)
    return
  }
  try {
    output.latest_version = installationVersion(await fetchInstallationSkill())
    const comparison = compareVersions(output.current_version, output.latest_version)
    output.status = comparison < 0 ? 'upgrade_available' : comparison > 0 ? 'local_newer' : 'up_to_date'
  } catch (error) {
    // Older published installation skills have no version metadata; skip silently.
    output.status = error.message === 'installation_skill_version_missing' ? 'skipped' : 'unknown'
    output.reason = ['installation_skill_version_missing', 'installation_skill_version_invalid', 'invalid_plugin_version'].includes(error.message)
      ? error.message : 'installation_skill_unavailable'
  }
  process.stdout.write(`${JSON.stringify(output)}\n`)
}

await main()
