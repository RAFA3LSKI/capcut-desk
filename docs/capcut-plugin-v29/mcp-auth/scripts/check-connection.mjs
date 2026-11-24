#!/usr/bin/env node
/**
 * Checks the CapCut account connection through Codex App Server without starting OAuth.
 * Usage: node check-connection.mjs --codex-cli /absolute/path/to/codex
 */

import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const SERVER_NAME = 'capcut_creation'
const TIMEOUT_MS = 30000

/** Parses the absolute native Codex executable path. */
function parseArgs(args) {
  if (args.length !== 2 || args[0] !== '--codex-cli' || !path.isAbsolute(args[1])) {
    throw new Error('Usage: node check-connection.mjs --codex-cli /absolute/path/to/codex')
  }
  return args[1]
}

/** Emits only the account connection classification, never credentials or tool data. */
function emit(status, reason) {
  process.stdout.write(`${JSON.stringify({ event: 'connection_check', server: SERVER_NAME, status, ...(reason ? { reason } : {}) })}\n`)
}

/** Queries one server's runtime and OAuth state through the native Codex App Server. */
function checkConnection(codexCLI) {
  const child = spawn(codexCLI, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
  const lines = readline.createInterface({ input: child.stdout })
  let finished = false
  const timer = setTimeout(() => finish('unknown', 'status_timeout'), TIMEOUT_MS)

  /** Sends one App Server JSON-RPC message without logging its response body. */
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Stops this probe and reports its safe result exactly once. */
  function finish(status, reason) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    emit(status, reason)
    lines.close()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }

  /** Interprets only the target server's connection and authentication state. */
  function onLine(line) {
    if (finished) return
    let message
    try {
      message = JSON.parse(line)
    } catch {
      finish('unknown', 'invalid_app_server_response')
      return
    }
    if (message.id === 1) {
      if (message.error) {
        finish('unknown', 'app_server_initialize_failed')
        return
      }
      send({ method: 'initialized', params: {} })
      send({ id: 2, method: 'mcpServerStatus/list', params: { serverName: SERVER_NAME, detail: 'toolsAndAuthOnly' } })
    } else if (message.id === 2) {
      if (message.error) {
        finish('unknown', 'connection_status_unavailable')
        return
      }
      const servers = message.result?.data
      const server = Array.isArray(servers) ? servers.find((entry) => entry?.name === SERVER_NAME) : null
      if (!server) {
        finish('unknown', 'server_status_missing')
      } else if (server.runtimeStatus === 'authenticationRequired' || server.authStatus === 'notLoggedIn') {
        finish('login_required')
      } else if (server.runtimeStatus === 'connected' && server.authStatus === 'oAuth') {
        finish('connected')
      } else {
        // Mixed servers can connect anonymously; transport state alone does not confirm OAuth.
        finish('unknown', 'connection_not_confirmed')
      }
    }
  }

  child.on('spawn', () => send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'capcut_connection_check', title: 'CapCut Connection Check', version: '0.1.0' } } }))
  child.on('error', () => finish('unknown', 'app_server_start_failed'))
  child.on('close', () => finish('unknown', 'app_server_exited'))
  child.stdin.on('error', () => finish('unknown', 'app_server_pipe_failed'))
  lines.on('line', onLine)
}

try {
  checkConnection(parseArgs(process.argv.slice(2)))
} catch {
  emit('unknown', 'invalid_arguments')
  process.exitCode = 1
}
