#!/usr/bin/env node
/**
 * Starts CapCut OAuth through Codex App Server without launching a system browser.
 * Codex opens the emitted authorization_url in its in-app browser and polls this
 * same process until the matching OAuth completion notification arrives.
 * Usage: node capcut-login.mjs --codex-cli /absolute/path/to/codex
 */

import path from 'node:path'
import { spawn } from 'node:child_process'
import readline from 'node:readline'

const SERVER_NAME = 'capcut_creation'
const INITIALIZE_ID = 1
const LOGIN_ID = 2
const STARTUP_TIMEOUT_MS = 60000

/** Parses the native Codex executable and the OAuth callback timeout. */
function parseArgs(args) {
  const options = { codexCLI: '', timeoutSeconds: 600 }
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]
    const value = args[index + 1]
    if (name === '--codex-cli' && value) {
      options.codexCLI = value
    } else if (name === '--timeout-seconds' && /^\d+$/.test(value || '')) {
      options.timeoutSeconds = Number(value)
    } else {
      throw new Error('Usage: node capcut-login.mjs --codex-cli /absolute/path/to/codex [--timeout-seconds 600]')
    }
  }
  if (!path.isAbsolute(options.codexCLI)) {
    throw new Error('--codex-cli must be the absolute path to the native Codex CLI')
  }
  if (!Number.isSafeInteger(options.timeoutSeconds) || options.timeoutSeconds < 1 || options.timeoutSeconds > 3600) {
    throw new Error('--timeout-seconds must be between 1 and 3600')
  }
  return options
}

/** Emits only the browser handoff or the final OAuth status as JSON lines. */
function emit(event, details) {
  process.stdout.write(`${JSON.stringify({ event, server: SERVER_NAME, ...details })}\n`)
}

/** Keeps one App Server connection alive for the entire OAuth flow. */
function login(options) {
  const child = spawn(options.codexCLI, ['app-server'], {
    stdio: ['pipe', 'pipe', 'ignore'],
    windowsHide: true,
  })
  const lines = readline.createInterface({ input: child.stdout })
  let initialized = false
  let authorizationRequired = false
  let finished = false
  let killTimer
  let timer = setTimeout(onTimeout, STARTUP_TIMEOUT_MS)

  /** Writes a protocol message without logging App Server traffic. */
  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  /** Reports one terminal result and stops only this helper's App Server. */
  function finish(success, error) {
    if (finished) return
    finished = true
    clearTimeout(timer)
    process.exitCode = success ? 0 : 1
    emit('completed', { success, ...(error ? { error } : {}) })
    lines.close()
    child.stdin.end()
    if (child.exitCode === null && child.signalCode === null) {
      child.kill()
      killTimer = setTimeout(forceStop, 3000)
      killTimer.unref()
    }
  }

  /** Stops a child that did not exit after its connection was closed. */
  function forceStop() {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  /** Treats a missing completion as incomplete authorization, never success. */
  function onTimeout() {
    finish(false, authorizationRequired
      ? 'Timed out waiting for Codex OAuth completion; authorization is incomplete'
      : 'Timed out waiting for Codex to prepare OAuth')
  }

  /** Initializes the documented App Server protocol after the process starts. */
  function onSpawn() {
    send({
      id: INITIALIZE_ID,
      method: 'initialize',
      params: { clientInfo: { name: 'capcut_oauth', title: 'CapCut OAuth', version: '0.1.0' } },
    })
  }

  /** Handles only this connection's login response and matching completion. */
  function onLine(line) {
    if (finished) return
    try {
      const message = JSON.parse(line)
      if (message.id === INITIALIZE_ID && !initialized) {
        if (message.error) {
          finish(false, message.error.message)
          return
        }
        initialized = true
        send({ method: 'initialized', params: {} })
        send({
          id: LOGIN_ID,
          method: 'mcpServer/oauth/login',
          params: { name: SERVER_NAME, timeoutSecs: options.timeoutSeconds },
        })
      } else if (message.id === LOGIN_ID && initialized && !authorizationRequired) {
        if (message.error) {
          finish(false, message.error.message)
          return
        }
        authorizationRequired = true
        clearTimeout(timer)
        timer = setTimeout(onTimeout, (options.timeoutSeconds + 10) * 1000)
        emit('authorization_required', { authorization_url: message.result.authorizationUrl })
      } else if (message.method === 'mcpServer/oauthLogin/completed' && initialized) {
        const result = message.params
        if (result.name === SERVER_NAME) finish(result.success, result.error)
      }
    } catch {
      finish(false, 'Codex App Server returned an invalid OAuth protocol message')
    }
  }

  /** Reports process or pipe errors without dumping protocol payloads. */
  function onError(error) {
    finish(false, error.message)
  }

  /** Cleans up the kill timer and rejects an exit without OAuth completion. */
  function onClose(code, signal) {
    clearTimeout(killTimer)
    if (!finished) finish(false, `Codex App Server exited before OAuth completed (${signal || code})`)
  }

  /** Cancels the local listener when the helper is interrupted. */
  function onInterrupt() {
    finish(false, 'Authorization was interrupted before completion')
  }

  child.on('spawn', onSpawn)
  child.on('error', onError)
  child.on('close', onClose)
  child.stdin.on('error', onError)
  lines.on('line', onLine)
  process.once('SIGINT', onInterrupt)
  process.once('SIGTERM', onInterrupt)
}

try {
  login(parseArgs(process.argv.slice(2)))
} catch (error) {
  emit('completed', { success: false, error: error.message })
  process.exitCode = 1
}
