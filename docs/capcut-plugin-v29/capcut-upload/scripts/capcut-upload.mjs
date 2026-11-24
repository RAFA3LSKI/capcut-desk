#!/usr/bin/env node
/* eslint-disable */
/**
 * capcut-upload.mjs — 零依赖的 CapCut 媒资上传脚本（Node.js 18+）
 *
 * 支持三类上传，均先经 MCP capcut_asset_upload_credential(version=2) 获取短票据，再由本脚本领取凭证并上传：
 *   - 视频/音频 -> VOD（火山点播 / CapCut AI Search-tiktok 网关）
 *   - 图片      -> ImageX（火山图片处理服务）
 *
 * 从浏览器 SDK packages/tt-uploader 抽取核心逻辑重写而成，去除所有浏览器依赖：
 *   - XMLHttpRequest      -> node:https
 *   - File/Blob/FileReader-> node:fs
 *   - crypto-js 签名       -> node:crypto（火山 V4 签名，等价实现）
 *   - Worker/localStorage/tea 日志 -> 移除
 *
 * VOD 上传链路（与 SDK 完全一致）：
 *   分片: crc32 -> apply(ApplyUploadInfo) -> init -> upload(分片) -> merge -> commit(CommitUploadInfo)
 *   直传: crc32 -> apply(ApplyUploadInfo) -> upload(整包)          -> commit(CommitUploadInfo)
 * ImageX 上传链路（对齐 tt-uploader image 分支）：
 *   直传: crc32 -> apply(ApplyImageUpload) -> upload(整包)         -> commit(CommitImageUpload)
 *   分片: crc32 -> apply(ApplyImageUpload) -> init -> upload(分片) -> merge -> commit(CommitImageUpload)
 *   ImageX 与 VOD 数据面、CRC32、签名(signV4 火山变体)完全共用，仅 Action/Version/域名/收发结构不同。
 *
 * 数据面（init/分片/merge/直传）使用服务端下发的 Auth 令牌，控制面（apply/commit）由本脚本 V4 签名。
 *
 * 用法：
 *   # 视频 -> VOD
 *   node scripts/capcut-upload.mjs --file ./a.mp4 --client-id video-1 --upload-ticket-stdin --json
 *   # 图片 -> ImageX
 *   node scripts/capcut-upload.mjs --file ./a.png --client-id image-1 --upload-ticket-stdin --json
 *   # 视频、音频和图片混合批量上传
 *   node scripts/capcut-upload.mjs \\
 *     --files '[{"client_id":"video-1","file":"./a.mp4"},{"client_id":"audio-1","file":"./a.mp3"},{"client_id":"image-1","file":"./cover.png"}]' \\
 *     --upload-ticket-stdin --json
 *
 * 鉴权：通过 --upload-ticket-stdin 传入 version=2 返回的短票据，脚本直接领取完整凭证。
 * 保留 --upload-session / --upload-session-stdin 兼容旧调用方；不接受拆分或手工拼装的 STS。
 * 自动化环境使用 stdin，避免票据出现在进程参数中；不打印或持久化完整凭证。
 *
 * 成功时（--json）向 stdout 输出：VOD 为 { success:true, vid, setPublic, result }，
 * ImageX 为 { success:true, uri, result }；指定 --result-file 时仅输出摘要并将编号和状态写入文件。
 * 失败输出 { success:false, ... } 并以非 0 退出。
 */

import fs from 'node:fs'
import path from 'node:path'
import https from 'node:https'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { URL } from 'node:url'

// ------------------------------ 常量 ------------------------------
const VOD_DOMAIN = {
  'cn-north-1': 'https://vod' + '.' + 'volcengineapi' + '.' + 'com',
  'ap-southeast-1': 'https://vod' + '.' + 'ap-southeast-1' + '.' + 'volcengineapi' + '.' + 'com',
}
const DEFAULT_REGION = 'cn-north-1'
const VOD_SERVICE = 'vod'
const VOD_VERSION = '2022-01-01'
const M = 1024 * 1024
const DEFAULT_UPLOAD_PARALLEL = 10
// 本地网络的带宽由整个批次共享，默认最多 2 个文件 × 10 个分片在途。
const uploadLogContext = new AsyncLocalStorage()
const RETRYABLE_NETWORK_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE',
  'EAI_AGAIN', 'ENOTFOUND', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE',
])
// 当前支持的视频、音频和图片扩展名，与服务端素材类型白名单保持一致。
const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mpeg', 'mpg', '3gp', 'ts', 'mts', 'm2ts'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'wma', 'aiff', 'aif'])
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'svg'])

// ------------------------------ ImageX 常量（对齐 tt-uploader image 分支）------------------------------
// 控制面（ApplyImageUpload/CommitImageUpload）与 VOD volc 一样走火山 HMAC-SHA256 变体（signV4），
// 仅 service 名不同：imagex（小写）。数据面（直传/分片）与 VOD volc 完全共用。
const IMAGEX_SERVICE = 'imagex'
const IMAGEX_VERSION = '2018-08-01'
// 各区 ImageX OpenAPI 域名（凭证不带控制面域名时按服务端签发的 region 选择）。
const IMAGEX_DOMAIN = {
  'cn-north-1': 'https://imagex' + '.' + 'volcengineapi' + '.' + 'com',
  'ap-southeast-1': 'https://imagex' + '.' + 'ap-southeast-1' + '.' + 'volcengineapi' + '.' + 'com',
}

// ------------------------------ CRC32 ------------------------------
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

/**
 * Formats a CRC32 number as an eight-character hexadecimal string.
 */
function toEight(hex) {
  while (hex.length < 8) hex = `0${hex}`
  return hex
}

/** 计算 buffer 的 crc32，返回 8 位十六进制字符串（与 SDK lib/crc32 一致） */
function computeCrc32(buf) {
  // 新版 Node 使用原生实现；旧版保留相同的 CRC32 算法，不增加第三方依赖。
  if (typeof zlib.crc32 === 'function') return toEight(zlib.crc32(buf).toString(16))
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let crc = -1
  for (let i = 0; i < u8.length; i++) {
    crc = CRC_TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8)
  }
  return toEight(((crc ^ -1) >>> 0).toString(16))
}

// ------------------------------ 火山 V4 签名 ------------------------------
const UNSIGNABLE_HEADERS = [
  'authorization',
  'content-type',
  'content-length',
  'user-agent',
  'presigned-expires',
  'expect',
  'x-amzn-trace-id',
]

/**
 * Escapes a string for canonical signed URI and query components.
 */
function uriEscape(str) {
  return encodeURIComponent(str)
    .replace(/[^A-Za-z0-9_.~\-%]+/g, escape)
    .replace(/[*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 与 SDK signers/queryParamsToString 保持一致：按 key 排序、逐项转义 */
function queryParamsToString(params) {
  return Object.keys(params)
    .sort()
    .map((key) => {
      const val = params[key]
      if (val === undefined || val === null) return
      const escapedKey = uriEscape(key)
      if (!escapedKey) return
      if (Array.isArray(val)) {
        return `${escapedKey}=${val.map(uriEscape).sort().join(`&${escapedKey}=`)}`
      }
      return `${escapedKey}=${uriEscape(String(val))}`
    })
    .filter((v) => v)
    .join('&')
}

/**
 * Creates an HMAC-SHA256 digest for signing requests.
 */
function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest()
}

/**
 * Computes a lowercase SHA256 hex digest for the provided data.
 */
function sha256hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex')
}

/**
 * Reports whether a header should be included in the canonical signature.
 */
function isSignableHeader(key) {
  const lower = key.toLowerCase()
  if (lower.indexOf('x-amz-') === 0) return true
  return UNSIGNABLE_HEADERS.indexOf(lower) < 0
}

/**
 * 火山 V4 签名，等价于 SDK AWSSignersV4（isVolcengine:true）。
 * @returns {{ Authorization:string, 'X-Date':string, [k:string]:string }} 需要追加到请求上的头
 */
function signV4({ method, params, headers, body, region, service, credentials, date }) {
  const dateHeader = 'X-Date'
  const tokenHeader = 'x-security-token'
  const contentSha256Header = 'X-Content-Sha256'
  const algorithm = 'HMAC-SHA256'

  const iso = date.toISOString().replace(/\.\d{3}Z$/, 'Z')
  const datetime = iso.replace(/[:-]|\.\d{3}/g, '')
  const date8 = datetime.substr(0, 8)

  const signHeaders = { ...headers, [dateHeader]: datetime }
  if (credentials.sessionToken) signHeaders[tokenHeader] = credentials.sessionToken
  if (body) signHeaders[contentSha256Header] = sha256hex(body)

  // canonical headers（signable、按 key 小写排序）
  const entries = Object.keys(signHeaders)
    .map((k) => [k, signHeaders[k]])
    .filter(([k]) => isSignableHeader(k))
    .sort((a, b) => (a[0].toLowerCase() < b[0].toLowerCase() ? -1 : 1))
  const canonicalHeaders = entries
    .map(([k, v]) => `${k.toLowerCase()}:${String(v).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '')}`)
    .join('\n')
  const signedHeaders = entries.map(([k]) => k.toLowerCase()).sort().join(';')

  const bodyHash = signHeaders[contentSha256Header] || sha256hex(body || '')
  const canonicalString = [
    method.toUpperCase(),
    '/',
    queryParamsToString(params || {}),
    `${canonicalHeaders}\n`,
    signedHeaders,
    bodyHash,
  ].join('\n')

  const credScope = [date8, region, service, 'request'].join('/')
  const stringToSign = [algorithm, datetime, credScope, sha256hex(canonicalString)].join('\n')

  const kDate = hmac(credentials.secretAccessKey, date8)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'request')
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `${algorithm} Credential=${credentials.accessKeyId}/${credScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`

  const out = { Authorization: authorization, [dateHeader]: datetime }
  if (credentials.sessionToken) out[tokenHeader] = credentials.sessionToken
  if (signHeaders[contentSha256Header]) out[contentSha256Header] = signHeaders[contentSha256Header]
  return out
}

/**
 * AWS4-HMAC-SHA256 签名（CapCut AI Search / tiktok VOD 内部网关 inner 协议使用）。
 * 与火山 volc 变体（signV4）的关键差异（经官方 @byted/ttuploader 抓包逐字节对齐）：
 *   - 算法/头名：AWS4-HMAC-SHA256、x-amz-date、x-amz-security-token（volc 是 HMAC-SHA256、X-Date、x-security-token）
 *   - 签名密钥前缀 'AWS4' + secret，scope 尾段 aws4_request（volc 无前缀、尾段 request）
 *   - GET 不签 body；POST 追加 x-amz-content-sha256 并纳入 SignedHeaders
 * canonQuery 同时用于签名与拼接实际 URL，确保二者逐字节一致。
 * @returns {{ authorization:string, canonQuery:string, headers:object }}
 */
/**
 * Builds AWS4-compatible authorization headers for inner CapCut VOD requests.
 */
function signAWS4({ method, params, body, region, service, credentials, date }) {
  const p = (n) => String(n).padStart(2, '0')
  const amzDate =
    `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  const dateStamp = amzDate.slice(0, 8)

  const payloadHash = sha256hex(body || '')
  const headers = { 'x-amz-date': amzDate }
  if (credentials.sessionToken) headers['x-amz-security-token'] = credentials.sessionToken
  if (body != null) headers['x-amz-content-sha256'] = payloadHash

  const hkeys = Object.keys(headers).sort()
  const canonicalHeaders = hkeys.map((k) => `${k}:${headers[k]}\n`).join('')
  const signedHeaders = hkeys.join(';')

  const canonQuery = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`)
    .join('&')

  const canonicalRequest = [method.toUpperCase(), '/', canonQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n')

  let k = hmac('AWS4' + credentials.secretAccessKey, dateStamp)
  k = hmac(k, region)
  k = hmac(k, service)
  k = hmac(k, 'aws4_request')
  const signature = crypto.createHmac('sha256', k).update(stringToSign, 'utf8').digest('hex')

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  return { authorization, canonQuery, headers: { ...headers, authorization } }
}

// ------------------------------ HTTP（node:https） ------------------------------
/**
 * Reads only non-secret lane routing fields from this plugin's MCP configuration.
 * Missing configuration preserves standalone/legacy production uploads; malformed
 * configuration fails instead of silently sending an authorized ticket to another lane.
 */
function mcpUploadRoutingHeaders() {
  let config
  try {
    config = JSON.parse(fs.readFileSync(new URL('../../../.mcp.json', import.meta.url), 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return {}
    throw new Error('无法读取插件 MCP 泳道配置')
  }
  const configured = config.mcpServers?.capcut_creation?.http_headers || {}
  const routing = {}
  for (const [name, value] of Object.entries(configured)) {
    const key = name.toLowerCase()
    if (key !== 'x-tt-env' && key !== 'x-use-ppe') continue
    if (typeof value !== 'string' || /[\r\n]/.test(value)) throw new Error('插件 MCP 泳道配置无效')
    routing[key] = value
  }
  return routing
}

/**
 * 发起 HTTPS 请求。
 * @returns {Promise<{status:number, body:string}>}
 */
function request({ method = 'GET', url, headers = {}, body, timeout = 60 * 1000, connectTimeout = 5000, idleTimeout, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }))
      return
    }
    const u = new URL(url)
    const mcpUpload = u.origin === 'https://www.capcut.com' &&
      ['/api/external_mcp/upload/credential', '/api/external_mcp/upload/finalize'].includes(u.pathname)
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: `${u.pathname}${u.search}`,
      headers: mcpUpload ? { ...mcpUploadRoutingHeaders(), ...headers } : headers,
      // 禁用 Agent 的默认 socket 超时；连接期限与连接后的空闲期限分别管理。
      timeout: 0,
    }
    let req
    let response
    let timer
    let connectTimer
    let socket
    let settled = false
    let connected = false
    let bodyFlushed = false
    let responseResult
    const started = Date.now()
    const network = { host: u.hostname, phase: 'socket', reused_socket: false }
    // 只记录连接阶段和耗时，不包含路径、请求头或上传授权。
    const onLookup = (error) => {
      network.lookup_ms = Date.now() - started
      network.phase = error ? 'dns' : 'tcp'
    }
    // TCP 已连通；提前保留 IP，连接关闭后仍能定位失败节点。
    const onTcpConnected = () => {
      network.tcp_ms = Date.now() - started
      network.phase = 'tls'
      network.remote_ip = socket.remoteAddress
    }
    // 统一释放定时器、取消监听与连接，覆盖连接、响应头和响应体阶段。
    const finish = (error, result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(connectTimer)
      if (idleTimeout) req?.setTimeout(0)
      req?.removeListener('timeout', onIdleTimeout)
      socket?.removeListener('secureConnect', onConnected)
      socket?.removeListener('lookup', onLookup)
      socket?.removeListener('connect', onTcpConnected)
      req?.removeListener('socket', onSocket)
      signal?.removeEventListener('abort', onAbort)
      network.elapsed_ms = Date.now() - started
      network.remote_ip = socket?.remoteAddress || network.remote_ip
      if (error) {
        error.network = { ...network }
        req?.destroy()
        response?.destroy()
        reject(error)
      } else {
        resolve(result)
      }
    }
    // 错误只包含网络错误码，避免 URL 查询参数或服务端回显泄露上传授权。
    const onError = (err) => finish(Object.assign(new Error(`NETERROR: ${err.code || 'UNKNOWN'}`), { code: err.code }))
    // 数据通道连续无网络活动时尽早重试；持续传输仍受独立总时限保护。
    const onIdleTimeout = () => finish(Object.assign(new Error(`IDLE_TIMEOUT: ${idleTimeout}ms`), { code: 'ETIMEDOUT' }))
    const onAbort = () => finish(Object.assign(new Error('请求已取消'), { code: 'ABORT_ERR' }))
    // DNS、TCP 与 TLS 共用连接期限；复用的 HTTPS socket 已完成握手。
    const onConnected = () => {
      if (connected) return
      connected = true
      network.tls_ms = Date.now() - started
      network.phase = 'send'
      clearTimeout(connectTimer)
      if (idleTimeout) req.setTimeout(idleTimeout, onIdleTimeout)
    }
    const onSocket = (assigned) => {
      socket = assigned
      network.reused_socket = Boolean(req.reusedSocket)
      const literalAddress = u.hostname.startsWith('[') || /^[\d.]+$/.test(u.hostname)
      network.phase = socket.connecting ? (literalAddress ? 'tcp' : 'dns') : 'tls'
      if (req.reusedSocket) onConnected()
      else {
        socket.once('lookup', onLookup)
        socket.once('connect', onTcpConnected)
        socket.once('secureConnect', onConnected)
      }
    }
    req = https.request(opts, (res) => {
      onConnected()
      response = res
      network.response_ms = Date.now() - started
      network.phase = 'receive'
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('error', onError)
      res.on('aborted', () => onError({ code: 'ECONNRESET' }))
      res.on('end', () => {
        const logId = res.headers?.['x-tt-logid']
        const requestId = typeof logId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(logId) ? logId : undefined
        responseResult = { status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), requestId, network }
        if (res.statusCode < 200 || res.statusCode >= 300) {
          // 服务端提前拒绝时立即停止发送；失败缓冲不会回到复用池。
          finish(null, responseResult)
          if (!bodyFlushed) req.destroy()
        } else if (bodyFlushed) {
          finish(null, responseResult)
        }
      })
      res.on('close', () => {
        if (!settled && !responseResult) onError({ code: 'ERR_STREAM_PREMATURE_CLOSE' })
      })
    })
    req.on('error', onError)
    req.once('socket', onSocket)
    signal?.addEventListener('abort', onAbort, { once: true })
    // socket inactivity timeout 会被持续流量重置；总时限不会被慢速响应无限延长。
    timer = setTimeout(() => finish(Object.assign(new Error(`TIMEOUT: ${timeout}ms`), { code: 'ETIMEDOUT' })), timeout)
    connectTimer = setTimeout(() => finish(Object.assign(new Error(`CONNECT_TIMEOUT: ${connectTimeout}ms`), { code: 'ETIMEDOUT' })), connectTimeout)
    try {
      // 收到响应不代表请求体已写完；必须等写入完成才能允许下一片覆盖 Buffer。
      req.end(body, (err) => {
        if (err) return onError(err)
        bodyFlushed = true
        network.sent_ms = Date.now() - started
        if (!response) network.phase = 'wait_response'
        if (responseResult) finish(null, responseResult)
      })
    } catch (err) {
      onError(err)
    }
  })
}

/**
 * Runs an HTTPS request with bounded retries for transient failures.
 */
async function requestWithRetry(opts, { retry = 5, interval = 200, label = '', retryStatus = false, beforeAttempt, stats } = {}) {
  for (let i = 0; ; i++) {
    const started = Date.now()
    try {
      beforeAttempt?.()
      if (stats && i > 0) {
        stats.retryCount++
        // 统计重试请求体大小，不将它误称为已送达服务端的网络字节数。
        stats.retryBodyBytes += opts.body?.length || 0
      }
      let response
      try {
        response = await request(opts)
      } finally {
        if (stats) stats.requestMs += Date.now() - started
      }
      if (retryStatus && ([408, 425, 429].includes(response.status) || response.status >= 500)) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { retryable: true, status: response.status, requestId: response.requestId, network: response.network })
      }
      // 重试可能留下尚在关闭的旧请求；这类请求体只用于本片重试，不再交给下一片覆盖。
      return { ...response, attempt: i + 1, bodyReusable: i === 0 }
    } catch (err) {
      if (opts.signal?.aborted) throw err
      const retrying = (err.retryable || RETRYABLE_NETWORK_CODES.has(err.code)) && i < retry
      const waitMs = retrying ? interval : 0
      err.attempt = i + 1
      log('请求失败', JSON.stringify({ operation: label, decision: retrying ? 'retry' : 'stop', attempt: err.attempt, max_attempts: retry + 1, elapsed_ms: Date.now() - started, wait_ms: waitMs, code: err.code, http_status: err.status, request_id: err.requestId, network: err.network, error: err.message }))
      if (!retrying) {
        err.message = `[${label || 'request'}] attempt=${err.attempt}: ${err.message}`
        throw err
      }
      const waiting = Date.now()
      try {
        await delay(waitMs, undefined, { signal: opts.signal })
      } finally {
        if (stats) stats.retryWaitMs += Date.now() - waiting
      }
    }
  }
}

// ------------------------------ 视频上传完成 ------------------------------
/**
 * Calls the capability-protected finalize endpoint to make the vid public.
 */
async function finalizeVideo(cfg, vid) {
  const body = JSON.stringify({ vid })
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${cfg.finalizeToken}`,
  }

  const res = await requestWithRetry(
    { method: 'POST', url: cfg.finalizeURL, headers, body, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg, true), label: '完成视频上传', retryStatus: true },
  )
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`finalize HTTP ${res.status}`)
  }
  let payload
  try {
    payload = JSON.parse(res.body)
  } catch {
    throw new Error('finalize 响应无法解析')
  }
  if (payload?.status !== 'success' || payload?.vid !== vid) {
    throw new Error(`finalize 失败: ${payload?.error || 'unexpected response'}`)
  }
  return payload
}

// ------------------------------ 工具 ------------------------------
/**
 * Writes progress messages to stderr so stdout can remain machine-readable JSON.
 */
function log(...args) {
  // 日志走 stderr，保持 stdout 纯净（便于 --json 解析）
  const file = uploadLogContext.getStore()
  process.stderr.write(`[capcut-upload] ${new Date().toISOString()}${file ? ` [${JSON.stringify(file)}]` : ''} ${args.join(' ')}\n`)
}

/** oid 中除首段（bucket）外做 encodeURIComponent，避免特殊字符问题（等价 util.resolveUri） */
function resolveUri(uri) {
  if (!uri) return ''
  const first = uri.split('/')[0]
  const rest = uri.split('/').slice(1).join('/')
  return `${first}/${encodeURIComponent(rest)}`
}

/** 服务端下发的 UploadHeader（数组或对象）转普通对象（等价 util.resolveHeader） */
function resolveHeader(hd, { gatewayUpload = false } = {}) {
  const ret = {}
  if (gatewayUpload) ret['x-storage-mode'] = 'gateway'
  if (Array.isArray(hd)) {
    hd.forEach((item) => {
      if (item.Key && item.Value) ret[String(item.Key).toLowerCase()] = item.Value
    })
    return ret
  }
  if (hd && typeof hd === 'object') return Object.assign(ret, hd)
  return ret
}

/** 图片分片步长策略，保持 ImageX 现有默认值。 */
function getSliceSize(size) {
  if (size <= 200 * M) return 5 * M
  if (size <= 500 * M) return 8 * M
  return 10 * M
}

/** 视频/音频不超过 500 MiB 时使用 3 MiB 分片，更大的文件使用 8 MiB。 */
function getVodSliceSize(size) {
  return size <= 500 * M ? 3 * M : 8 * M
}

/** 将文件连续切片；默认尾片独立，图片可指定尾片合并阈值。 */
function buildSlices(fileSize, sliceSize, minTailSize = 0) {
  const slices = []
  let start = 0
  let end = 0
  while (end < fileSize) {
    end = Math.min(start + sliceSize, fileSize)
    // 视频/音频不合并尾片，避免降低并发或超过步长；图片保留原合并规则。
    const remaining = fileSize - end
    if (remaining > 0 && remaining <= sliceSize && remaining < minTailSize) end = fileSize
    slices.push({ start, end })
    start = end
  }
  return slices
}

/**
 * 完整读取指定范围到已租用的 Buffer；短读继续补齐，避免发送残留字节。
 */
async function readSlice(fd, buf, start, signal) {
  const length = buf.length
  let read = 0
  while (read < length) {
    if (signal?.aborted) throw Object.assign(new Error('读取分片已取消'), { code: 'ABORT_ERR' })
    const n = await new Promise((resolve, reject) => {
      fs.read(fd, buf, read, length - read, start + read, (err, bytesRead) => err ? reject(err) : resolve(bytesRead))
    })
    if (n <= 0) throw new Error(`文件提前结束: offset=${start + read}, expected_end=${start + length}`)
    read += n
  }
  return buf
}

/** 整批共享有界 Buffer 池；活跃和空闲缓冲均计入上限，按相同长度复用。 */
function createBufferPool(limit) {
  let allocated = 0
  const free = []
  const pending = []
  // FIFO 调度；尺寸不匹配时先淘汰空闲缓冲，再等待在途分片归还容量。
  const drain = () => {
    while (pending.length) {
      const item = pending[0]
      const index = free.findIndex((buffer) => buffer.length === item.bytes)
      let buffer
      if (index >= 0) {
        buffer = free.splice(index, 1)[0]
      } else {
        while (free.length && allocated + item.bytes > limit) allocated -= free.pop().length
        if (allocated + item.bytes > limit) break
        try {
          // 独立 backing store，避免小 Buffer 的共享 slab 超出池的字节核算。
          buffer = Buffer.allocUnsafeSlow(item.bytes)
          allocated += buffer.length
        } catch (err) {
          pending.shift()
          item.signal?.removeEventListener('abort', item.onAbort)
          item.reject(err)
          continue
        }
      }
      pending.shift()
      item.signal?.removeEventListener('abort', item.onAbort)
      let released = false
      item.resolve({
        buffer,
        /** 幂等归还；异常路径丢弃缓冲，成功路径可显式允许复用。 */
        release(reusable = false) {
          if (released) return
          released = true
          if (reusable) free.push(buffer)
          else allocated -= buffer.length
          drain()
        },
      })
    }
  }
  return {
    /** 租用独占缓冲；只有确认所有发送均已结束后才允许 release(true)。 */
    acquire(bytes, signal) {
      if (bytes > limit) return Promise.reject(new Error('分片超过缓冲预算，请增大 --buffer-limit-mib 或减小 --slice-size（尾片可能合并）'))
      return new Promise((resolve, reject) => {
        const item = { bytes, signal, resolve, reject }
        item.onAbort = () => {
          const index = pending.indexOf(item)
          if (index >= 0) pending.splice(index, 1)
          signal?.removeEventListener('abort', item.onAbort)
          reject(Object.assign(new Error('等待上传缓冲已取消'), { code: 'ABORT_ERR' }))
          drain()
        }
        if (signal?.aborted) return item.onAbort()
        pending.push(item)
        signal?.addEventListener('abort', item.onAbort, { once: true })
        drain()
      })
    },
  }
}

/** 租用缓冲后异步读取、校验并上传；同片重试保留原字节，成功且无重试才归池复用。 */
async function uploadSlice(cfg, fd, start, end, transfer, controller) {
  const signal = controller?.signal
  const waiting = Date.now()
  const lease = await cfg.bufferPool.acquire(end - start, signal)
  let reusable = false
  if (cfg.stats) cfg.stats.bufferWaitMs += Date.now() - waiting
  try {
    assertUploadAuthorization(cfg)
    const started = Date.now()
    const buffer = await readSlice(fd, lease.buffer, start, signal)
    if (signal?.aborted) throw Object.assign(new Error('上传分片已取消'), { code: 'ABORT_ERR' })
    const crc32 = computeCrc32(buffer)
    if (cfg.stats) cfg.stats.readCrcMs += Date.now() - started
    reusable = await transfer({ buffer, crc32, signal }) === true
    if (cfg.stats) cfg.stats.confirmedBytes += buffer.length
    return crc32
  } catch (err) {
    // 先取消同文件等待者再释放额度，防止失败后又唤醒一个分片读取。
    controller?.abort(err)
    throw err
  } finally {
    lease.release(reusable)
  }
}

/** 按限额读取并上传本地分片；任一片失败后取消同文件请求，等全部 worker 退出再允许关闭 fd。 */
async function uploadParts(cfg, fd, sliceSize, transfer) {
  const slices = buildSlices(cfg.fileSize, sliceSize, cfg.kind === 'image' ? 5 * M : 0)
  // 只在成功确认后记录 CRC；会话、进度和待重试字节仅存于当前进程，不写断点文件。
  const crc32List = new Array(slices.length)
  const parallel = Math.min(cfg.uploadSliceCount, slices.length)
  const controller = new AbortController()
  let next = 0
  let done = 0
  log(`阶段 upload: 共 ${slices.length} 片, 并发 ${parallel}...`)
  // 一个 worker 持有一个分片的内存，重试复用同一份字节和分片编号。
  const worker = async () => {
    while (!controller.signal.aborted && next < slices.length) {
      const idx = next++
      const { start, end } = slices[idx]
      const started = Date.now()
      try {
        crc32List[idx] = await uploadSlice(cfg, fd, start, end, (part) => transfer({ ...part, partNumber: idx + 1, partOffset: start }), controller)
        done++
        log(`分片 ${idx + 1}/${slices.length} 完成 (${Math.round(done / slices.length * 100)}%), bytes=${end - start}, elapsed_ms=${Date.now() - started}`)
      } catch (err) {
        // 只记录首个故障；其他 worker 的联动取消不重复刷失败日志。
        if (!controller.signal.aborted || controller.signal.reason === err) {
          err.message = `part=${idx + 1}, offset=${start}, bytes=${end - start}: ${err.message}`
          log('分片失败', JSON.stringify({ part: idx + 1, offset: start, bytes: end - start, elapsed_ms: Date.now() - started, attempt: err.attempt, code: err.code, error: err.message }))
        }
        controller.abort(err)
      }
    }
  }
  await Promise.all(Array.from({ length: parallel }, () => worker()))
  if (controller.signal.aborted) throw controller.signal.reason
  return crc32List
}

/**
 * Extracts a normalized file extension from a file name.
 */
function getFileSuffix(fileName) {
  if (!fileName) return null
  const pos = fileName.lastIndexOf('.')
  return pos > 0 ? `.${fileName.substring(pos + 1)}` : null
}

// ------------------------------ 各阶段 ------------------------------
/** 以服务端 CurrentTime 加本进程已流逝时间计算签名时间；未启用时使用本机时间。 */
function getSignDate(cfg) {
  if (cfg.useServerCurrentTime && cfg.credentials?.currentTime) {
    // 包含批次排队、apply/init 和上传耗时，避免后续文件仍使用批次开始时的签名时间。
    return new Date(new Date(cfg.credentials.currentTime).getTime() + Date.now() - cfg.signingStartedAt)
  }
  return new Date()
}

/** 用服务端时钟检查已知期限；finalize 只依赖自己的 capability，不要求 STS 仍有效。 */
function assertUploadAuthorization(cfg, finalizeOnly = false) {
  const now = getSignDate(cfg).getTime()
  if (!Number.isFinite(now)) throw new Error('上传凭证 current_time 无效')
  if (!finalizeOnly && cfg.credentialExpiresAt !== undefined) {
    if (!Number.isFinite(cfg.credentialExpiresAt)) throw new Error('上传凭证 expired_time 无效')
    if (cfg.credentialExpiresAt <= now) throw Object.assign(new Error('上传凭证已过期，请重新获取授权'), { code: 'UPLOAD_CREDENTIAL_EXPIRED' })
  }
  if (cfg.kind !== 'image' && cfg.finalizeExpiresAt !== undefined) {
    if (!Number.isSafeInteger(cfg.finalizeExpiresAt) || cfg.finalizeExpiresAt <= 0) throw new Error('finalize expires_at 无效')
    if (cfg.finalizeExpiresAt * 1000 <= now) throw Object.assign(new Error('finalize 授权已过期，请重新获取授权'), { code: 'FINALIZE_CAPABILITY_EXPIRED' })
  }
}

/**
 * Parses and validates a VOD OpenAPI response body.
 */
function assertVodResponse(bodyStr, stage) {
  const parsed = parseResponseJSON(bodyStr, stage)
  const err = parsed?.ResponseMetadata?.Error
  if (err) {
    throw new Error(`[${stage}] code=${err.Code}(${err.CodeN}); RequestId=${parsed.ResponseMetadata.RequestId}`)
  }
  return parsed.Result
}

/** 解析协议响应；JSON 错误不带原始正文，避免凭证或 SessionKey 被回显。 */
function parseResponseJSON(bodyStr, stage) {
  try {
    return JSON.parse(bodyStr)
  } catch {
    throw new Error(`[${stage}] 响应不是有效 JSON`)
  }
}

/** 校验 Inner 数据面的 HTTP 和业务状态，统一保留阶段及错误码。 */
function assertInnerResponse(res, stage) {
  try {
    if (res.status < 200 || res.status >= 300) throw new Error(`[${stage}] HTTP ${res.status}`)
    const parsed = parseResponseJSON(res.body, stage)
    if (parsed.code !== 2000) throw new Error(`[${stage}] code=${parsed.code}`)
    return parsed
  } catch (err) {
    err.attempt = res.attempt
    err.message += `; attempt=${res.attempt}`
    throw err
  }
}

/**
 * Parses and validates a transporter upload response body.
 */
function assertTransporterResponse(bodyStr, status, stage) {
  if (status < 200 || status >= 300) {
    throw new Error(`[${stage}] HTTP ${status}`)
  }
  let parsed
  try {
    parsed = JSON.parse(bodyStr)
  } catch (e) {
    // 部分数据面接口成功时可能无 JSON body
    return null
  }
  if (parsed.success !== 0 && parsed.success !== undefined) {
    const e = parsed.error || {}
    throw new Error(`[${stage}] code=${e.error_code}`)
  }
  return parsed.payload
}

/** apply: ApplyUploadInfo，拿到 oid / signature / tosDomain / uploadHeader / sessionKey */
async function applyUpload(cfg) {
  const host = cfg.videoHost || VOD_DOMAIN[cfg.region] || VOD_DOMAIN[DEFAULT_REGION]
  const params = {
    Action: 'ApplyUploadInfo',
    Version: VOD_VERSION,
    SpaceName: cfg.spaceName,
    FileSize: cfg.fileSize,
    FileType: cfg.fileType,
    NeedFallback: true,
  }
  if (cfg.fileName) params.FileName = cfg.fileName
  const ext = cfg.fileExtension || (cfg.useFileExtension ? getFileSuffix(cfg.fileName || cfg.baseName) : null)
  if (ext) params.FileExtension = ext
  if (cfg.storageClass !== undefined && cfg.storageClass !== null) params.StorageClass = cfg.storageClass
  if (cfg.accountId) params['X-Account-Id'] = cfg.accountId
  params.s = Math.random().toString(36).substr(2)

  const signed = signV4({
    method: 'GET',
    params,
    headers: {},
    region: cfg.region,
    service: VOD_SERVICE,
    credentials: cfg.credentials,
    date: getSignDate(cfg),
  })
  const url = `${host}?${queryParamsToString(params)}`
  const res = await requestWithRetry(
    { method: 'GET', url, headers: signed, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'apply' },
  )
  const result = assertVodResponse(res.body, 'apply')
  const detail =
    result?.Data?.CandidateUploadAddresses?.MainUploadAddresses?.[0] ?? result?.Data?.UploadAddress
  if (!detail) throw new Error('[apply] 返回缺少上传地址')
  const store = detail.StoreInfos[0]
  return {
    oid: resolveUri(store.StoreUri),
    signature: store.Auth,
    tosDomain: `${cfg.schema}://${detail.UploadHosts[0]}`,
    sessionKey: detail.SessionKey,
    serverUploadHeader: detail.UploadHeader,
  }
}

/** init: 初始化分片上传，拿到 uploadId */
async function initUpload(cfg, ctx) {
  const url = `${ctx.tosDomain}/${ctx.oid}?uploads`
  const res = await requestWithRetry(
    {
      method: 'POST',
      url,
      headers: { authorization: ctx.signature, ...ctx.uploadHeader },
      timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout,
    },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'init' },
  )
  const payload = assertTransporterResponse(res.body, res.status, 'init')
  const uploadId = payload?.uploadID
  if (!uploadId) throw new Error('[init] 未获取到 uploadID')
  return uploadId
}

/** 上传单个分片；成功时返回请求体是否可供下一片复用。 */
async function uploadChunk(cfg, ctx, { url, buffer, crc32, partNumber = 1, signal }) {
  const headers = {
    authorization: ctx.signature,
    'content-crc32': crc32,
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(buffer.length),
    ...ctx.uploadHeader,
  }
  const res = await requestWithRetry(
    { method: 'POST', url, headers, body: buffer, timeout: cfg.uploadTimeout, connectTimeout: cfg.connectTimeout, idleTimeout: cfg.uploadIdleTimeout, signal },
    { retry: cfg.retryUploadTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), stats: cfg.stats, label: `upload part=${partNumber}`, retryStatus: true },
  )
  if (res.status < 200 || res.status >= 300) {
    throw Object.assign(new Error(`[upload] part=${partNumber} attempt=${res.attempt}: HTTP ${res.status}`), { attempt: res.attempt })
  }
  return res.bodyReusable
}

/** merge: 合并所有分片 */
async function mergeUpload(cfg, ctx, crc32List) {
  const content = crc32List.map((crc32, i) => `${i + 1}:${crc32}`).join(',')
  const url = `${ctx.tosDomain}/${ctx.oid}?uploadID=${ctx.uploadId}`
  const res = await requestWithRetry(
    {
      method: 'POST',
      url,
      headers: { authorization: ctx.signature, ...ctx.uploadHeader },
      body: content,
      timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout,
    },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'merge' },
  )
  assertTransporterResponse(res.body, res.status, 'merge')
}

/** commit: CommitUploadInfo，返回媒资信息（含 Vid） */
async function commitUpload(cfg, ctx) {
  const host = cfg.videoHost || VOD_DOMAIN[cfg.region] || VOD_DOMAIN[DEFAULT_REGION]
  const params = {
    Action: 'CommitUploadInfo',
    Version: VOD_VERSION,
    SpaceName: cfg.spaceName,
  }
  if (cfg.accountId) params['X-Account-Id'] = cfg.accountId
  const bodyObj = { SessionKey: ctx.sessionKey }
  if (Array.isArray(cfg.processAction) && cfg.processAction.length > 0) bodyObj.Functions = cfg.processAction
  if (cfg.callbackArgs) bodyObj.CallbackArgs = cfg.callbackArgs
  if (cfg.expireTime) bodyObj.ExpireTime = cfg.expireTime

  const urlBody = Object.keys(bodyObj)
    .map((key) => {
      const value = bodyObj[key]
      const tag = Object.prototype.toString.call(value)
      if (tag === '[object Array]' || tag === '[object Object]') {
        return `${key}=${encodeURIComponent(JSON.stringify(value))}`
      }
      return `${key}=${encodeURIComponent(value)}`
    })
    .join('&')

  const signed = signV4({
    method: 'POST',
    params,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlBody,
    region: cfg.region,
    service: VOD_SERVICE,
    credentials: cfg.credentials,
    date: getSignDate(cfg),
  })
  const url = `${host}?${queryParamsToString(params)}`
  const res = await requestWithRetry(
    {
      method: 'POST',
      url,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...signed },
      body: urlBody,
      timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout,
    },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'commit' },
  )
  const result = assertVodResponse(res.body, 'commit')
  return result?.Data
}

// ------------------------------ ImageX 协议（图片上传）------------------------------
// 对齐 tt-uploader image 分支。控制面 apply/commit 有两种签名/域名，按 cfg.imagexProtocol 分流：
//   - volc：火山公有云 ImageX OpenAPI，signV4 火山变体（service=imagex）
//   - inner：CapCut AI Search / tiktok ImageX 网关（imagex-upload-sg.tiktok.com），signAWS4（AWS4-HMAC-SHA256）
// 两者的请求参数、响应结构（result.UploadAddress）、数据面（直传/分片）完全一致，仅签名算法与控制面域名不同。

/** apply(ImageX)：ApplyImageUpload，拿到 oid / signature / tosDomain / sessionKey / uploadHeader */
async function applyImageUpload(cfg) {
  const isInner = cfg.imagexProtocol === 'inner'
  const host = isInner ? cfg.imagexHost : cfg.imagexHost || IMAGEX_DOMAIN[cfg.region] || IMAGEX_DOMAIN[DEFAULT_REGION]
  const params = {
    Action: 'ApplyImageUpload',
    Version: IMAGEX_VERSION,
    ServiceId: cfg.imageServiceId,
    UploadNum: 1,
  }
  const ext = cfg.fileExtension || (cfg.useFileExtension ? getFileSuffix(cfg.fileName || cfg.baseName) : null)
  if (ext) params.FileExtension = ext
  if (cfg.storeKey) params.StoreKeys = cfg.storeKey
  if (cfg.accountId) params['X-Account-Id'] = cfg.accountId
  params.s = Math.random().toString(36).substr(2)

  let url
  let headers
  if (isInner) {
    // tiktok ImageX 网关：AWS4 签名，canonQuery 同时用于签名与拼 URL，确保逐字节一致
    const signed = signAWS4({
      method: 'GET',
      params,
      region: cfg.region,
      service: IMAGEX_SERVICE,
      credentials: cfg.credentials,
      date: getSignDate(cfg),
    })
    url = `${host}?${signed.canonQuery}`
    headers = signed.headers
  } else {
    const signed = signV4({
      method: 'GET',
      params,
      headers: {},
      region: cfg.region,
      service: IMAGEX_SERVICE,
      credentials: cfg.credentials,
      date: getSignDate(cfg),
    })
    url = `${host}?${queryParamsToString(params)}`
    headers = signed
  }
  const res = await requestWithRetry(
    { method: 'GET', url, headers, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'apply(imagex)' },
  )
  const result = assertVodResponse(res.body, 'apply(imagex)')
  const detail = result?.UploadAddress
  const store = detail?.StoreInfos?.[0]
  if (!store) throw new Error('[apply(imagex)] 返回缺少上传地址')
  return {
    storeUri: store.StoreUri, // 原始 StoreUri，供 commit 的 SuccessOids 使用
    oid: resolveUri(store.StoreUri), // 数据面 URL 用（除 bucket 外的段做 encode）
    signature: store.Auth,
    tosDomain: `${cfg.schema}://${detail.UploadHosts[0]}`,
    sessionKey: detail.SessionKey,
    serverUploadHeader: detail.UploadHeader,
  }
}

/** commit(ImageX)：CommitImageUpload，body 为 JSON {SessionKey,SuccessOids}，返回最终图片 Uri */
async function commitImageUpload(cfg, ctx) {
  const isInner = cfg.imagexProtocol === 'inner'
  const host = isInner ? cfg.imagexHost : cfg.imagexHost || IMAGEX_DOMAIN[cfg.region] || IMAGEX_DOMAIN[DEFAULT_REGION]
  const params = {
    Action: 'CommitImageUpload',
    Version: IMAGEX_VERSION,
    ServiceId: cfg.imageServiceId,
  }
  if (cfg.skipMeta) params.SkipMeta = true
  if (cfg.accountId) params['X-Account-Id'] = cfg.accountId

  const bodyObj = { SessionKey: ctx.sessionKey, SuccessOids: [ctx.storeUri] }
  if (Array.isArray(cfg.processAction) && cfg.processAction.length > 0) bodyObj.Functions = cfg.processAction
  const body = JSON.stringify(bodyObj)

  let url
  let headers
  if (isInner) {
    const signed = signAWS4({
      method: 'POST',
      params,
      body,
      region: cfg.region,
      service: IMAGEX_SERVICE,
      credentials: cfg.credentials,
      date: getSignDate(cfg),
    })
    url = `${host}?${signed.canonQuery}`
    headers = { ...signed.headers, 'Content-Type': 'application/json' }
  } else {
    const signed = signV4({
      method: 'POST',
      params,
      headers: { 'Content-Type': 'application/json' },
      body,
      region: cfg.region,
      service: IMAGEX_SERVICE,
      credentials: cfg.credentials,
      date: getSignDate(cfg),
    })
    url = `${host}?${queryParamsToString(params)}`
    headers = { 'Content-Type': 'application/json', ...signed }
  }
  const res = await requestWithRetry(
    { method: 'POST', url, headers, body, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'commit(imagex)' },
  )
  const result = assertVodResponse(res.body, 'commit(imagex)')
  return result?.Results?.[0]
}

/** ImageX 主流程：apply -> upload(直传/分片) -> commit，返回 { Uri, UriStatus, ... } */
async function uploadImage(cfg) {
  const stat = fs.statSync(cfg.file)
  if (!stat.isFile()) throw new Error(`不是有效文件: ${cfg.file}`)
  cfg.fileSize = stat.size
  cfg.baseName = path.basename(cfg.file)
  const sliceSize = cfg.sliceSize || getSliceSize(cfg.fileSize)
  const isDirect = cfg.fileSize < sliceSize * 2

  log(`[imagex] 文件: ${cfg.baseName} (${cfg.fileSize} bytes), 模式: ${isDirect ? '直传' : '分片'}, 分片大小: ${sliceSize}`)

  log('阶段 apply(ApplyImageUpload)...')
  const applied = await applyImageUpload(cfg)
  const ctx = {
    storeUri: applied.storeUri,
    oid: applied.oid,
    signature: applied.signature,
    tosDomain: applied.tosDomain,
    sessionKey: applied.sessionKey,
    uploadHeader: resolveHeader(applied.serverUploadHeader, { gatewayUpload: !isDirect }),
  }
  log(`apply(imagex) 成功 oid=${ctx.oid}`)

  const fd = fs.openSync(cfg.file, 'r')
  try {
    if (isDirect) {
      log('阶段 upload(直传整包)...')
      await uploadSlice(cfg, fd, 0, cfg.fileSize, (part) => uploadChunk(cfg, ctx, { ...part, url: `${ctx.tosDomain}/${ctx.oid}` }))
    } else {
      log('阶段 init...')
      ctx.uploadId = await initUpload(cfg, ctx)
      log(`init 成功 uploadId=${ctx.uploadId}`)

      const crc32List = await uploadParts(cfg, fd, sliceSize, (part) => {
        const url = `${ctx.tosDomain}/${ctx.oid}?partNumber=${part.partNumber}&uploadID=${ctx.uploadId}`
        return uploadChunk(cfg, ctx, { ...part, url })
      })

      log('阶段 merge...')
      await mergeUpload(cfg, ctx, crc32List)
      log('merge 成功')
    }
  } finally {
    fs.closeSync(fd)
  }

  log('阶段 commit(CommitImageUpload)...')
  const data = await commitImageUpload(cfg, ctx)
  log('commit(imagex) 成功')
  return data
}

// ------------------------------ Inner 协议（CapCut AI Search / tiktok VOD 网关） ------------------------------
// 经官方 @byted/ttuploader@0.1.34 抓包对齐：控制面走 ApplyUploadInner/CommitUploadInner
// （Version=2020-11-19，AWS4 签名），数据面走 TOS 分片协议（SpaceKey 令牌，phase=init/transfer/finish）。
const INNER_VERSION = '2020-11-19'

/** apply(Inner)：拿到数据面上传节点（host / storeUri / SpaceKey Auth / SessionKey） */
async function applyUploadInner(cfg) {
  const host = cfg.videoHost
  const params = {
    Action: 'ApplyUploadInner',
    Version: INNER_VERSION,
    SpaceName: cfg.spaceName,
    FileType: cfg.fileType,
    IsInner: '1',
    FileSize: String(cfg.fileSize),
  }
  if (cfg.accountId) params['X-Account-Id'] = cfg.accountId

  const { canonQuery, headers } = signAWS4({
    method: 'GET',
    params,
    region: cfg.region,
    service: VOD_SERVICE,
    credentials: cfg.credentials,
    date: getSignDate(cfg),
  })
  const url = `${host}?${canonQuery}`
  const res = await requestWithRetry(
    { method: 'GET', url, headers, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'apply(inner)' },
  )
  const result = assertVodResponse(res.body, 'apply(inner)')
  const node = result?.InnerUploadAddress?.UploadNodes?.[0]
  const store = node?.StoreInfos?.[0]
  if (!node || !store) throw new Error('[apply(inner)] 返回缺少上传节点')
  return {
    uploadHost: node.UploadHost,
    storeUri: store.StoreUri,
    auth: store.Auth,
    sessionKey: node.SessionKey,
    userU: crypto.randomUUID(),
  }
}

/** init(Inner)：初始化分片上传，拿到 uploadid */
async function initUploadInner(cfg, ctx) {
  const url = `${cfg.schema}://${ctx.uploadHost}/upload/v1/${ctx.storeUri}?uploadmode=part&phase=init`
  const res = await requestWithRetry(
    { method: 'POST', url, headers: { authorization: ctx.auth, 'x-storage-u': ctx.userU }, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'init(inner)' },
  )
  const parsed = assertInnerResponse(res, 'init(inner)')
  return parsed.data.uploadid
}

/** transfer(Inner)：按 CRC 和偏移上传分片，成功时返回请求体是否可供下一片复用。 */
async function transferChunkInner(cfg, ctx, { partNumber, partOffset, buffer, crc32, signal }) {
  const q = `uploadid=${ctx.uploadId}&part_number=${partNumber}&phase=transfer&part_offset=${partOffset}`
  const url = `${cfg.schema}://${ctx.uploadHost}/upload/v1/${ctx.storeUri}?${q}`
  const headers = {
    authorization: ctx.auth,
    'x-storage-u': ctx.userU,
    'content-crc32': crc32,
    'content-type': 'application/octet-stream',
    'content-disposition': 'attachment; filename="undefined"',
    'Content-Length': String(buffer.length),
  }
  const res = await requestWithRetry(
    { method: 'POST', url, headers, body: buffer, timeout: cfg.uploadTimeout, connectTimeout: cfg.connectTimeout, idleTimeout: cfg.uploadIdleTimeout, signal },
    { retry: cfg.retryUploadTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), stats: cfg.stats, label: `transfer(inner) part=${partNumber}`, retryStatus: true },
  )
  assertInnerResponse(res, `transfer(inner) part=${partNumber}`)
  return res.bodyReusable
}

/** finish(Inner)：合并分片，body 为 "1:crc,2:crc,..."（升序） */
async function finishUploadInner(cfg, ctx, crc32List) {
  const body = crc32List.map((crc32, i) => `${i + 1}:${crc32}`).join(',')
  const url = `${cfg.schema}://${ctx.uploadHost}/upload/v1/${ctx.storeUri}?uploadmode=part&phase=finish&uploadid=${ctx.uploadId}&size=${cfg.fileSize}`
  // 重试仅重发同一 uploadId 与 CRC 列表的 finish，不重新 apply/init 或上传分片。
  const res = await requestWithRetry(
    { method: 'POST', url, headers: { authorization: ctx.auth, 'x-storage-u': ctx.userU }, body, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'finish(inner)', retryStatus: true },
  )
  assertInnerResponse(res, 'finish(inner)')
}

/** commit(Inner)：CommitUploadInner，body 为 JSON {SessionKey,Functions,CallbackArgs}，AWS4 签名 */
async function commitUploadInner(cfg, ctx) {
  const host = cfg.videoHost
  const params = { Action: 'CommitUploadInner', Version: INNER_VERSION, SpaceName: cfg.spaceName }
  if (cfg.accountId) params['X-Account-Id'] = cfg.accountId
  const bodyObj = { SessionKey: ctx.sessionKey }
  if (Array.isArray(cfg.processAction) && cfg.processAction.length > 0) bodyObj.Functions = cfg.processAction
  if (cfg.callbackArgs) bodyObj.CallbackArgs = cfg.callbackArgs
  if (cfg.expireTime) bodyObj.ExpireTime = cfg.expireTime
  const body = JSON.stringify(bodyObj)

  const { canonQuery, headers } = signAWS4({
    method: 'POST',
    params,
    body,
    region: cfg.region,
    service: VOD_SERVICE,
    credentials: cfg.credentials,
    date: getSignDate(cfg),
  })
  const url = `${host}?${canonQuery}`
  const res = await requestWithRetry(
    { method: 'POST', url, headers: { ...headers, 'content-type': 'application/json' }, body, timeout: cfg.requestTimeout, connectTimeout: cfg.connectTimeout },
    { retry: cfg.retryTaskTime, interval: cfg.retryInterval, beforeAttempt: () => assertUploadAuthorization(cfg), label: 'commit(inner)' },
  )
  const result = assertVodResponse(res.body, 'commit(inner)')
  return result?.Results?.[0]
}

/** Inner 协议主流程：apply -> init -> transfer(并发) -> finish -> commit */
async function uploadInner(cfg) {
  const stat = fs.statSync(cfg.file)
  if (!stat.isFile()) throw new Error(`不是有效文件: ${cfg.file}`)
  cfg.fileSize = stat.size
  cfg.baseName = path.basename(cfg.file)
  const sliceSize = cfg.sliceSize || getVodSliceSize(cfg.fileSize)
  log(`[inner] 文件: ${cfg.baseName} (${cfg.fileSize} bytes), 分片大小: ${sliceSize}`)

  log('阶段 apply(ApplyUploadInner)...')
  const applied = await applyUploadInner(cfg)
  const ctx = { ...applied }
  log(`apply(inner) 成功 host=${ctx.uploadHost} uri=${ctx.storeUri}`)

  const fd = fs.openSync(cfg.file, 'r')
  try {
    log('阶段 init...')
    ctx.uploadId = await initUploadInner(cfg, ctx)
    log(`init 成功 uploadid=${ctx.uploadId}`)

    const crc32List = await uploadParts(cfg, fd, sliceSize, (part) => transferChunkInner(cfg, ctx, part))

    log('阶段 finish...')
    await finishUploadInner(cfg, ctx, crc32List)
    log('finish 成功')
  } finally {
    fs.closeSync(fd)
  }

  log('阶段 commit(CommitUploadInner)...')
  const data = await commitUploadInner(cfg, ctx)
  log('commit(inner) 成功')
  return data
}

// ------------------------------ 主流程 ------------------------------
/**
 * Uploads a file through the selected VOD protocol and returns the upload result.
 */
async function upload(cfg) {
  const stat = fs.statSync(cfg.file)
  if (!stat.isFile()) throw new Error(`不是有效文件: ${cfg.file}`)
  cfg.fileSize = stat.size
  cfg.baseName = path.basename(cfg.file)
  const sliceSize = cfg.sliceSize || getVodSliceSize(cfg.fileSize)
  const isDirect = cfg.fileSize <= sliceSize

  log(`文件: ${cfg.baseName} (${cfg.fileSize} bytes), 模式: ${isDirect ? '直传' : '分片'}, 分片大小: ${sliceSize}`)

  // 1) apply
  log('阶段 apply(ApplyUploadInfo)...')
  const applied = await applyUpload(cfg)
  const ctx = {
    oid: applied.oid,
    signature: applied.signature,
    tosDomain: applied.tosDomain,
    sessionKey: applied.sessionKey,
    uploadHeader: resolveHeader(applied.serverUploadHeader, { gatewayUpload: !isDirect }),
  }
  log(`apply 成功 oid=${ctx.oid}`)

  const fd = fs.openSync(cfg.file, 'r')
  try {
    if (isDirect) {
      // 直传：整包一次上传
      log('阶段 upload(直传整包)...')
      await uploadSlice(cfg, fd, 0, cfg.fileSize, (part) => uploadChunk(cfg, ctx, { ...part, url: `${ctx.tosDomain}/${ctx.oid}` }))
    } else {
      // 分片：init -> 逐片上传 -> merge
      log('阶段 init...')
      ctx.uploadId = await initUpload(cfg, ctx)
      log(`init 成功 uploadId=${ctx.uploadId}`)

      const crc32List = await uploadParts(cfg, fd, sliceSize, (part) => {
        const url = `${ctx.tosDomain}/${ctx.oid}?partNumber=${part.partNumber}&uploadID=${ctx.uploadId}`
        return uploadChunk(cfg, ctx, { ...part, url })
      })

      log('阶段 merge...')
      await mergeUpload(cfg, ctx, crc32List)
      log('merge 成功')
    }
  } finally {
    fs.closeSync(fd)
  }

  // commit
  log('阶段 commit(CommitUploadInfo)...')
  const data = await commitUpload(cfg, ctx)
  log('commit 成功')
  return data
}

// ------------------------------ CLI ------------------------------
// 已移除的凭证、路由覆盖和私有上传参数。显式拒绝它们，避免旧调用方式被静默忽略。
const REMOVED_OPTIONS = [
  'access-key-id',
  'secret-access-key',
  'session-token',
  'sts-token',
  'current-time',
  'expired-time',
  'space-name',
  'image-service-id',
  'imagex-host',
  'region',
  'protocol',
  'account-id',
  'host',
  'kind',
  'use-server-current-time',
  'no-server-current-time',
  'file-type',
  'file-extension',
  'use-file-extension',
  'vod-credential',
  'imagex-credential',
  'mcp-endpoint',
  'mcp-token',
  'no-set-public',
]

/**
 * Parses command-line arguments into an option map.
 */
function parseArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    }
  }
  return args
}

/**
 * Reads one upload ticket or legacy upload-session JSON document from stdin.
 *
 * Pipes are consumed until EOF. For a TTY, raw mode avoids the terminal's
 * canonical line-size limit and disables echo; a newline terminates the input.
 */
async function readUploadInputFromStdin() {
  const input = process.stdin
  if (!input.isTTY || typeof input.setRawMode !== 'function') {
    const chunks = []
    for await (const chunk of input) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8').trim()
  }

  return new Promise((resolve, reject) => {
    const chunks = []
    let rawModeEnabled = false
    let settled = false

    const cleanup = () => {
      input.off('data', onData)
      input.off('end', onEnd)
      input.off('error', onError)
      if (rawModeEnabled) input.setRawMode(false)
      input.pause()
    }
    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(Buffer.concat(chunks).toString('utf8').trim())
    }
    const onData = (chunk) => {
      const data = Buffer.from(chunk)
      for (let i = 0; i < data.length; i++) {
        if (data[i] === 3) {
          finish(new Error('从 stdin 读取上传授权已取消'))
          return
        }
        if (data[i] === 10 || data[i] === 13) {
          if (i > 0) chunks.push(data.subarray(0, i))
          finish()
          return
        }
      }
      chunks.push(data)
    }
    const onEnd = () => finish()
    const onError = (error) => finish(error)

    input.on('data', onData)
    input.on('end', onEnd)
    input.on('error', onError)
    try {
      input.setRawMode(true)
      rawModeEnabled = true
      input.resume()
    } catch (error) {
      finish(error)
    }
  })
}

/**
 * 清洗外部凭证字符串字段：去除前后空白，以及包裹用的反引号 / 单双引号。
 * 例如 " `https://vod-upload-sg.tiktok.com` " -> "https://vod-upload-sg.tiktok.com"。
 */
function cleanCredField(v) {
  let s = String(v).trim()
  // 反复剥离成对的包裹符号（` ' "），兼容多层包裹
  while (s.length >= 2 && ['`', "'", '"'].includes(s[0]) && s[s.length - 1] === s[0]) {
    s = s.slice(1, -1).trim()
  }
  return s
}

/** 读取有上下界的整数参数，拒绝缺值、NaN、负数及可能造成无限调度的输入。 */
function integerOption(args, key, fallback, min, max) {
  if (args[key] === undefined) return fallback
  const value = Number(args[key])
  if (typeof args[key] !== 'string' || !args[key].trim() || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${key} 必须是 ${min} 到 ${max} 之间的整数`)
  }
  return value
}

/**
 * Detects CapCut inner upload control planes from their host or credential region.
 */
function isInnerUploadControlPlane(host, region) {
  return /(?:tiktok\.com|tiktokw\.us)/i.test(host) ||
    /(^|[^a-z])(sg|us-ttp)([^a-z]|$)/i.test(region)
}

/**
 * Builds the runtime upload configuration from an MCP-issued short-lived credential.
 * @param {object} args CLI arguments scoped to one file.
 * @param {'video'|'audio'|'image'} expectedKind File kind determined before credential validation.
 * @param {object|undefined} issuedCredential Credential selected from the complete upload session.
 */
function buildConfig(args, expectedKind, issuedCredential) {
  // 仅接受 capcut_asset_upload_credential 返回的完整 vod_credential 或 imagex_credential。
  // 保留 CurrentTime/ExpiredTime，供服务端时间签名使用（对齐原库 tasks/apply.js、commit.js）。
  let credentials = {}
  // 凭证按文件类型从完整 upload session 中选择，调用方不能手工拼接。
  let vodCred = expectedKind !== 'image' && issuedCredential ? { ...issuedCredential } : null
  let imagexCred = expectedKind === 'image' && issuedCredential ? { ...issuedCredential } : null
  if (vodCred) {
    // 外部数据可能带有前后空白、反引号或引号（如 upload_host = " `https://...` "），
    // 逐字段清洗，避免污染签名 scope / 域名 / SpaceName（对齐“鲁棒解析外部不规范数据”约定）。
    for (const k of [
      'access_key_id', 'secret_access_key', 'session_token',
      'current_time', 'expired_time', 'region', 'upload_host', 'space_name',
    ]) {
      if (typeof vodCred[k] === 'string') vodCred[k] = cleanCredField(vodCred[k])
    }
    credentials = {
      accessKeyId: vodCred.access_key_id,
      secretAccessKey: vodCred.secret_access_key,
      sessionToken: vodCred.session_token,
      currentTime: vodCred.current_time || undefined,
      expiredTime: vodCred.expired_time || undefined,
    }
  }
  if (imagexCred) {
    for (const k of [
      'access_key_id', 'secret_access_key', 'session_token',
      'current_time', 'expired_time', 'region', 'upload_host', 'image_service_id',
    ]) {
      if (typeof imagexCred[k] === 'string') imagexCred[k] = cleanCredField(imagexCred[k])
    }
    credentials = {
      accessKeyId: imagexCred.access_key_id,
      secretAccessKey: imagexCred.secret_access_key,
      sessionToken: imagexCred.session_token,
      currentTime: imagexCred.current_time || undefined,
      expiredTime: imagexCred.expired_time || undefined,
    }
  }

  // upload_host 补全 schema 前缀（MCP 只给裸域名）
  const credHost = vodCred?.upload_host
    ? (/^https?:\/\//.test(vodCred.upload_host) ? vodCred.upload_host : `https://${vodCred.upload_host}`)
    : undefined
  // ImageX 凭证的 upload_host 是 inner/SG 控制面网关域名（如 imagex-upload-sg.tiktok.com），同样补全 schema
  const credImagexHost = imagexCred?.upload_host
    ? (/^https?:\/\//.test(imagexCred.upload_host) ? imagexCred.upload_host : `https://${imagexCred.upload_host}`)
    : undefined
  // 文件扩展名决定上传目标；后续校验对应类型的服务端凭证是否存在。
  const kind = expectedKind

  const cfg = {
    file: args.file,
    kind,
    credentialCount: Number(!!vodCred) + Number(!!imagexCred),
    unsupportedOptions: REMOVED_OPTIONS.filter((key) => args[key] !== undefined),
    spaceName: vodCred?.space_name,
    region: vodCred?.region || imagexCred?.region || DEFAULT_REGION,
    fileType: 'video',
    fileName: args['file-name'] || undefined,
    fileExtension: undefined,
    useFileExtension: false,
    storageClass: args['storage-class'] !== undefined ? Number(args['storage-class']) : undefined,
    videoHost: credHost || undefined,
    schema: args['schema'] || 'https',
    accountId: (vodCred?.top_account_id != null ? String(vodCred.top_account_id) : undefined)
      || (imagexCred?.top_account_id != null ? String(imagexCred.top_account_id) : undefined),
    // MCP 短期凭证场景固定使用凭证携带的服务端时间作为签名基准。
    useServerCurrentTime: true,
    signingStartedAt: Date.now(),
    sliceSize: integerOption(args, 'slice-size', undefined, 1, 64 * M),
    uploadSliceCount: integerOption(args, 'parallel', DEFAULT_UPLOAD_PARALLEL, 1, 10),
    retryUploadTime: integerOption(args, 'retry-upload', 5, 0, 5),
    retryTaskTime: integerOption(args, 'retry-task', 5, 0, 5),
    retryInterval: 200,
    requestTimeout: integerOption(args, 'request-timeout-ms', 60 * 1000, 1000, 30 * 60 * 1000),
    connectTimeout: integerOption(args, 'connect-timeout-ms', 5000, 1000, 120000),
    uploadIdleTimeout: integerOption(args, 'upload-idle-timeout-ms', 10000, 1000, 30 * 60 * 1000),
    uploadTimeout: integerOption(args, 'upload-timeout-ms', 5 * 60 * 1000, 1000, 30 * 60 * 1000),
    processAction: args['process-action'] ? JSON.parse(args['process-action']) : undefined,
    callbackArgs: args['callback-args'] || undefined,
    expireTime: args['expire-time'] || undefined,
    // ImageX 专属配置仅取自服务端签发的 imagex_credential。
    imageServiceId: imagexCred?.image_service_id || undefined,
    imagexHost: credImagexHost,
    storeKey: args['store-key'] || undefined,
    skipMeta: args['skip-meta'] !== undefined ? true : false,
    credentials,
    credentialExpiresAt: credentials.expiredTime === undefined ? undefined : Date.parse(credentials.expiredTime),
  }

  // 协议选择（VOD/视频）：inner（CapCut AI Search / tiktok VOD 网关，AWS4 + ApplyUploadInner）
  //   或 volc（火山公有云 OpenAPI，HMAC-SHA256 + ApplyUploadInfo）。
  // 按服务端凭证的 host、region 和 provider 自动选择协议，不允许调用方覆盖。
  const host = cfg.videoHost || ''
  const looksInner = isInnerUploadControlPlane(host, cfg.region) || vodCred?.provider === 1
  cfg.protocol = looksInner ? 'inner' : 'volc'

  // 协议选择（ImageX/图片）：与 VOD 同构。inner=tiktok ImageX 网关（AWS4 + 凭证 upload_host），
  //   volc=火山公有云 ImageX OpenAPI（HMAC-SHA256）。
  // 按服务端凭证自动判断：tiktok 网关、SG 或 US-TTP 区走 inner。
  const ihost = cfg.imagexHost || ''
  const looksImagexInner = isInnerUploadControlPlane(ihost, cfg.region)
  cfg.imagexProtocol = looksImagexInner ? 'inner' : 'volc'
  return cfg
}

/**
 * Validates the upload configuration before network calls are made.
 */
function validate(cfg) {
  const errors = []
  if (cfg.credentialCount !== 1)
    errors.push(cfg.kind === 'image'
      ? 'upload session 缺少 imagex_credential'
      : 'upload session 缺少 vod_credential')
  if (cfg.unsupportedOptions.length > 0)
    errors.push(`不再支持的参数: ${cfg.unsupportedOptions.map((key) => `--${key}`).join(', ')}`)
  if (!cfg.file) errors.push('缺少 --file <文件路径>')
  else if (!fs.existsSync(cfg.file)) errors.push(`文件不存在: ${cfg.file}`)
  else {
    const extension = path.extname(cfg.file).slice(1).toLowerCase()
    const supported = cfg.kind === 'image' ? IMAGE_EXTENSIONS : cfg.kind === 'audio' ? AUDIO_EXTENSIONS : VIDEO_EXTENSIONS
    if (!supported.has(extension)) {
      errors.push(cfg.kind === 'image'
        ? `仅支持图片上传，当前文件扩展名不受支持: ${extension || '(无扩展名)'}`
        : `当前${cfg.kind === 'audio' ? '音频' : '视频'}文件扩展名不受支持: ${extension || '(无扩展名)'}`)
    }
  }
  if (cfg.credentialCount === 1) {
    if (!cfg.credentials.accessKeyId) errors.push('MCP 短期凭证缺少 access_key_id')
    if (!cfg.credentials.secretAccessKey)
      errors.push('MCP 短期凭证缺少 secret_access_key')
    if (cfg.kind === 'image') {
      // 图片 -> ImageX：ServiceId 必须来自 imagex_credential。
      if (!cfg.imageServiceId)
        errors.push('MCP imagex_credential 缺少 image_service_id')
      // inner（tiktok / SG）ImageX 控制面网关域名必须来自凭证。
      if (cfg.imagexProtocol === 'inner' && !cfg.imagexHost)
        errors.push('MCP imagex_credential 缺少 SG/inner ImageX 所需的 upload_host')
    } else {
      // 视频/音频 -> VOD
      if (!cfg.spaceName) errors.push('MCP vod_credential 缺少 space_name')
      if (cfg.protocol === 'inner' && !cfg.videoHost)
        errors.push('MCP vod_credential 缺少 inner 协议所需的 upload_host')
    }
  }
  if (cfg.kind === 'video' || cfg.kind === 'audio') {
    if (!cfg.finalizeToken) errors.push('upload session 缺少 vod_finalize.token')
    if (!isTrustedFinalizeURL(cfg.finalizeURL)) errors.push('upload session 缺少可信的 vod_finalize.url')
  }
  return errors
}

/**
 * Checks that a finalize URL points to the fixed HTTPS CapCut endpoint before sending its capability token.
 */
function isTrustedFinalizeURL(value) {
  try {
    const parsed = new URL(value)
    const trustedHost = parsed.hostname === 'capcut.com' || parsed.hostname.endsWith('.capcut.com')
    return parsed.protocol === 'https:' && trustedHost && parsed.pathname === '/api/external_mcp/upload/finalize'
  } catch {
    return false
  }
}

/**
 * Parses the mutually exclusive single-file and batch-file CLI inputs.
 */
function parseUploadFiles(args) {
  const hasFile = args.file !== undefined
  const hasFiles = args.files !== undefined
  if (hasFile === hasFiles) {
    throw new Error('必须且只能提供 --file <path> 或 --files \'<JSON数组>\'')
  }
  if (hasFile) {
    return [{ file: String(args.file), clientId: args['client-id'] ? String(args['client-id']).trim() : '' }]
  }

  const files = JSON.parse(args.files)
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('--files 必须是包含至少 1 个文件路径的 JSON 数组')
  }
  if (files.some((item) => !item || typeof item !== 'object' || Array.isArray(item) ||
    typeof item.file !== 'string' || !item.file.trim() ||
    typeof item.client_id !== 'string' || !item.client_id.trim())) {
    throw new Error('--files 中的每一项都必须包含非空 file 和 client_id')
  }
  const clientIds = files.map((item) => item.client_id.trim())
  if (new Set(clientIds).size !== clientIds.length) {
    throw new Error('--files 中的 client_id 必须唯一')
  }
  return files.map((item) => ({ file: item.file.trim(), clientId: item.client_id.trim() }))
}

/**
 * Classifies a local path as a supported video, audio, or image from its extension.
 */
function classifyUploadKind(file) {
  const extension = path.extname(file).slice(1).toLowerCase()
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  throw new Error(`仅支持视频、音频和图片: ${file}`)
}

/**
 * Exchanges a short ticket at the fixed service endpoint; secrets stay in process memory.
 * Repeated requests read the same server snapshot and never mint fresh credentials.
 */
async function fetchUploadSession(ticket, files, connectTimeout) {
  if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{21}[AQgw]$/.test(ticket)) {
    throw new Error('invalid_upload_ticket: 必须原样传入完整的 22 字符票据')
  }
  const specs = files.map((item) => {
    classifyUploadKind(item.file)
    const stat = fs.statSync(item.file)
    if (!stat.isFile() || stat.size <= 0) throw new Error(`文件不可上传: ${item.file}`)
    return { file_name: path.basename(item.file), size_bytes: stat.size }
  })
  const body = JSON.stringify({ files: specs })
  const response = await requestWithRetry({
    method: 'POST',
    url: 'https://www.capcut.com/api/external_mcp/upload/credential',
    headers: {
      Authorization: `Bearer ${ticket}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
    body,
    timeout: 30000,
    connectTimeout,
  }, { label: '领取上传凭证', retryStatus: true })
  if (response.status !== 200) {
    // Do not echo arbitrary response bodies: proxies and servers may include sensitive data.
    const reason = response.status === 401 ? 'invalid_upload_ticket' :
      response.status === 403 ? 'upload_files_mismatch' : 'upload_credential_request_failed'
    throw new Error(`${reason}: HTTP ${response.status}`)
  }
  let session
  try {
    session = JSON.parse(response.body)
  } catch {
    throw new Error('上传凭证响应无法解析')
  }
  if (!session || session.status !== 'success') throw new Error('上传凭证响应无效')
  return session
}

/**
 * Builds one isolated runtime configuration per file in a single or mixed batch.
 */
function buildUploadConfigs(args, files, session) {
  if (!session || session.status !== 'success') {
    throw new Error('upload session 必须是完整的成功凭证响应')
  }
  const finalize = session.vod_finalize ?? session.video_finalize
  const bufferPool = createBufferPool(integerOption(args, 'buffer-limit-mib', 512, 1, 1024) * M)
  return files.map((item) => {
    const kind = classifyUploadKind(item.file)
    const itemArgs = { ...args, file: item.file }
    delete itemArgs.files
    const credential = kind === 'image' ? session.imagex_credential : session.vod_credential
    const cfg = buildConfig(itemArgs, kind, credential)
    cfg.clientId = item.clientId
    cfg.finalizeURL = finalize?.url || ''
    cfg.finalizeToken = finalize?.token || ''
    cfg.finalizeExpiresAt = finalize?.expires_at
    cfg.bufferPool = bufferPool
    cfg.stats = { confirmedBytes: 0, retryBodyBytes: 0, retryCount: 0, requestMs: 0, retryWaitMs: 0, readCrcMs: 0, bufferWaitMs: 0 }
    return cfg
  })
}

/**
 * Builds the minimal configuration needed to retry video finalization without re-uploading the file.
 */
function buildFinalizeOnlyConfig(args, session) {
  if (!session || session.status !== 'success') {
    throw new Error('upload session 必须是完整的成功凭证响应')
  }
  const vid = typeof args['finalize-vid'] === 'string' ? args['finalize-vid'].trim() : ''
  if (!vid) throw new Error('--finalize-vid 不能为空')

  const clientId = typeof args['client-id'] === 'string' ? args['client-id'].trim() : ''

  const finalize = session.vod_finalize ?? session.video_finalize
  const cfg = {
    clientId,
    finalizeURL: finalize?.url || '',
    finalizeToken: finalize?.token || '',
    finalizeExpiresAt: finalize?.expires_at,
    credentials: { currentTime: session.vod_credential?.current_time },
    useServerCurrentTime: true,
    signingStartedAt: Date.now(),
    connectTimeout: integerOption(args, 'connect-timeout-ms', 5000, 1000, 120000),
    retryTaskTime: integerOption(args, 'retry-task', 5, 0, 5),
    retryInterval: 200,
    requestTimeout: integerOption(args, 'request-timeout-ms', 60 * 1000, 1000, 30 * 60 * 1000),
  }
  if (!cfg.finalizeToken) throw new Error('upload session 缺少 vod_finalize.token')
  if (!isTrustedFinalizeURL(cfg.finalizeURL)) throw new Error('upload session 缺少可信的 vod_finalize.url')
  return { cfg, vid }
}

/**
 * Retries only capability authorization and the make-public stage for an already uploaded vid.
 */
async function runFinalizeOnly(args, session) {
  const { cfg, vid } = buildFinalizeOnlyConfig(args, session)
  try {
    const finalize = await finalizeVideo(cfg, vid)
    return {
      success: true,
      uploadSuccess: true,
      stage: 'set_public',
      clientId: cfg.clientId,
      kind: 'vod',
      vid,
      setPublic: { success: true, result: finalize },
    }
  } catch (err) {
    return {
      success: false,
      uploadSuccess: true,
      stage: 'set_public',
      retryable: err.code !== 'FINALIZE_CAPABILITY_EXPIRED',
      clientId: cfg.clientId,
      kind: 'vod',
      vid,
      setPublic: { success: false, error: err.message },
      error: err.message,
    }
  }
}

/**
 * Uploads one validated video, audio, or image and returns its structured result.
 */
async function uploadOne(cfg) {
  assertUploadAuthorization(cfg)
  if (cfg.kind === 'image') {
    log(`目标: ImageX（图片上传）协议: ${cfg.imagexProtocol}${cfg.imagexProtocol === 'inner' ? '（CapCut AI Search / tiktok ImageX 网关，AWS4）' : '（火山公有云 OpenAPI）'}`)
    const data = await uploadImage(cfg)
    const uri = data?.Uri || null
    log(`上传成功! Uri=${uri}`)
    return { success: true, file: cfg.file, clientId: cfg.clientId, kind: 'image', uri, result: data }
  }

  log(`协议: ${cfg.protocol}${cfg.protocol === 'inner' ? '（CapCut AI Search / tiktok VOD 网关）' : '（火山公有云 OpenAPI）'}`)
  const data = cfg.protocol === 'inner' ? await uploadInner(cfg) : await upload(cfg)
  const vid = data?.Vid || data?.vid || null

  // 上传成功后强制完成 capability 授权与设公开；失败时整体返回失败，但保留 vid 供只重试 finalize。
  if (!vid) {
    return {
      success: false,
      uploadSuccess: true,
      stage: 'set_public',
      file: cfg.file,
      clientId: cfg.clientId,
      kind: cfg.kind,
      vid: null,
      error: 'VOD 上传成功但未返回 vid',
    }
  }
  try {
    log(`完成${cfg.kind === 'audio' ? '音频' : '视频'}上传: 校验 finalize capability 并设公开 vid=${vid}`)
    const finalize = await finalizeVideo(cfg, vid)
    log(`${cfg.kind === 'audio' ? '音频' : '视频'} finalize 成功`)
    return {
      success: true,
      file: cfg.file,
      clientId: cfg.clientId,
      kind: cfg.kind,
      vid,
      setPublic: { success: true, result: finalize },
      result: data,
    }
  } catch (err) {
    log(`${cfg.kind === 'audio' ? '音频' : '视频'} finalize 失败（上传已成功，不重传）: ${err.message}`)
    return {
      success: false,
      uploadSuccess: true,
      stage: 'set_public',
      retryable: err.code !== 'FINALIZE_CAPABILITY_EXPIRED',
      file: cfg.file,
      clientId: cfg.clientId,
      kind: cfg.kind,
      vid,
      setPublic: { success: false, error: err.message },
      error: err.message,
    }
  }
}

/**
 * Creates a private result file before uploading so an invalid path cannot waste an upload.
 */
function openResultFile(args) {
  if (args['result-file'] === undefined) return null
  const resultFile = args['result-file']
  if (!args.json || typeof resultFile !== 'string' || !path.isAbsolute(resultFile)) {
    throw new Error('--result-file 需要 --json 和绝对文件路径')
  }
  return fs.openSync(resultFile, 'wx', 0o600)
}

/**
 * Keeps only identifiers and status needed for recovery, excluding downstream response bodies.
 */
function persistedResultItem(item) {
  const { success, file, clientId, kind, vid, uri, uploadSuccess, stage, retryable, error } = item
  const setPublic = item.setPublic && { success: item.setPublic.success, error: item.setPublic.error }
  return { success, file, clientId, kind, vid, uri, uploadSuccess, stage, retryable, setPublic, error }
}

/**
 * Saves each file's identifier and status, then prints a short summary.
 */
function outputResult(args, result, resultFileFD) {
  if (resultFileFD === null) {
    if (args.json) process.stdout.write(JSON.stringify(result) + '\n')
    else log(JSON.stringify(result, null, 2))
    return
  }
  let writeError
  try {
    const savedResult = Array.isArray(result.results)
      ? { success: result.success, results: result.results.map(persistedResultItem) }
      : persistedResultItem(result)
    fs.writeFileSync(resultFileFD, JSON.stringify(savedResult) + '\n')
    fs.fsyncSync(resultFileFD)
  } catch (err) {
    writeError = err
  } finally {
    try {
      fs.closeSync(resultFileFD)
    } catch (err) {
      writeError ||= err
    }
  }
  if (writeError) throw new Error(`result_file_write_failed: ${writeError.message}`)
  process.stdout.write(JSON.stringify({
    success: result.success,
    result_file: args['result-file'],
    result_count: Array.isArray(result.results) ? result.results.length : 1,
  }) + '\n')
}

const HELP = `capcut-upload.mjs — CapCut 媒资上传（视频/音频->VOD，图片->ImageX；Node.js 18+，无第三方依赖）

必填：
  文件（必须且只能选择一种；批量至少 1 个）：
    --file <path>            单个待上传文件路径
    --files '<JSON数组>'     {client_id,file} 对象数组，支持视频/音频/图片混合批次
  上传授权（必须且只能选择一种）：
    --upload-ticket-stdin      从 stdin 读取 version=2 返回的短票据；TTY 输入以换行结束（推荐）
    --upload-ticket <ticket>   直接传入短票据；可能暴露在进程参数中
    --upload-session '<JSON>'  旧版兼容：直接传入完整成功凭证响应
    --upload-session-stdin     旧版兼容：从 stdin 读取完整凭证响应；TTY 输入以换行结束

可选（通用）：
  --client-id <id>          单文件模式的本地结果标识，不传给凭证 API
  --file-name <name>         旧版 session 模式指定媒资文件名
  --slice-size <bytes>       自定义分片大小，1 到 67108864；视频/音频默认按文件大小 ÷ 10，限制在 3–20 MiB
                            视频/音频尾片独立；图片按文件大小默认 5/8/10 MiB，尾片保留原合并规则
  --file-parallel <n>        同时上传文件数，1 到 5，默认 2
  --parallel <n>             每文件分片并发数，1 到 10，默认 10
  --buffer-limit-mib <n>     整批 Buffer 池上限，1 到 1024 MiB，默认 512；须容纳单个实际分片
  --connect-timeout-ms <ms>  DNS/TCP/TLS 连接时限，1000 到 120000，默认 5000
  --retry-upload <n>         分片失败后的重试次数，0 到 5，默认 5（总共最多 6 次尝试）
  --retry-task <n>           控制面网络错误及 finish 临时 HTTP 错误的重试次数，0 到 5，默认 5
  --upload-idle-timeout-ms <ms> 数据请求连续无网络活动时限，默认 10000（10 秒）
  --upload-timeout-ms <ms>   单次数据上传请求总时限，默认 300000（5 分钟）
  --request-timeout-ms <ms>  单次控制面/finalize 请求总时限，默认 60000（1 分钟）
                            时限范围 1000 到 1800000；领取票据凭证固定为 30000
  --process-action '<JSON>'  VOD 转码 / ImageX 处理 Functions 数组
  --json                     以 JSON 输出结果到 stdout
  --result-file <绝对路径>   与 --json 一起使用，将逐文件编号和状态写入新文件（0600），stdout 仅输出摘要
  --help                     显示帮助

调度与重试：
  本脚本读取本地文件，无远程分段下载；默认最多 2 × 10 个分片在途，结果保持输入顺序。
  分片对临时网络错误及 HTTP 408/425/429/5xx 重试，复用同一 uploadId、分片编号与字节。
  Inner finish 的 HTTP 408/425/429/5xx 同样有限重试，复用原 uploadId 与 CRC 列表。
  默认最多重试 5 次，每次固定等待 200 毫秒；领取上传凭证采用相同默认策略。
  取消、鉴权错误和业务错误不重试，不重新上传整个文件。
  会话和分片进度仅保存在内存，已成功分片不重传；不写断点文件，不支持进程退出后续传。
  单片不可重试或重试耗尽后，停止同文件调度、取消在途请求并等待退出；其他文件继续。
  数据请求连续 30 秒无网络活动即触发同片重试；持续传输不触发空闲超时。
  请求总时限覆盖连接、请求体写入和响应结束；不设置整批 2 分钟限制，适用于本地慢速网络。
  直传与分片共用 Buffer 池，相同大小的成功缓冲可复用；活跃和空闲缓冲均计入上限。
  请求体写完且响应成功才允许复用；失败或发生重试的缓冲不归池。池上限不是整个 Node 进程的 RSS 上限。
  文件启动及请求重试前按服务端时间检查已知授权期限；不自动续期，不将票据到期当上传授权到期。
  stderr 汇总确认字节、重试请求体字节、重试次数及请求/等待/读取校验耗时；并发耗时按累加计。
  Node 支持时使用原生 CRC32，否则沿用原算法；stdout 默认保留最终 JSON，指定结果文件时仅输出摘要。

视频/音频 finalize 重试（不重传文件）：
  --finalize-vid <vid>       仅重试设公开；票据模式须同时提供原 --file，旧 session 模式不提供文件

可选（视频/音频 -> VOD）：
  --storage-class <n>        存储类型
  --callback-args <str>      回调参数
  --expire-time <ISO>        媒资过期时间
  上传完成后脚本强制调用 upload session 中的 capability finalize endpoint，服务端验证
  短时 capability 后设公开。任一步失败均返回整体失败。

可选（图片 -> ImageX）：
  --store-key <key>          指定存储 StoreKey（透传为 StoreKeys）
  --skip-meta                CommitImageUpload 时带 SkipMeta=true（跳过元信息解析）

示例：
  # 单个视频：启动后从 stdin 输入短票据并换行
  node scripts/capcut-upload.mjs --file ./demo.mp4 \\
    --client-id video-1 \\
    --upload-ticket-stdin \\
    --json

  # 单个图片
  node scripts/capcut-upload.mjs --file ./demo.png \\
    --client-id image-1 \\
    --upload-ticket-stdin \\
    --json

  # 视频、音频和图片混合批次
  node scripts/capcut-upload.mjs \\
    --files '[{"client_id":"video-1","file":"./demo.mp4"},{"client_id":"audio-1","file":"./voice.mp3"},{"client_id":"image-1","file":"./cover.png"}]' \\
    --upload-ticket-stdin \\
    --json

  # 视频或音频已上传但 finalize 失败：仅重试设公开
  node scripts/capcut-upload.mjs --finalize-vid '<VID>' --file ./demo.mp4 \\
    --client-id video-1 \\
    --upload-ticket-stdin \\
    --json
`

/**
 * Runs the CLI entrypoint and prints the JSON result or error.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || Object.keys(args).length === 0) {
    process.stdout.write(HELP)
    process.exit(0)
  }
  let files
  let configs
  let session
  let fileParallel
  let resultFileFD = null
  try {
    fileParallel = integerOption(args, 'file-parallel', 2, 1, 5)
    const connectTimeout = integerOption(args, 'connect-timeout-ms', 5000, 1000, 120000)
    const authOptions = ['upload-ticket', 'upload-ticket-stdin', 'upload-session', 'upload-session-stdin']
    const selected = authOptions.filter((key) => args[key] !== undefined)
    if (selected.length !== 1) {
      throw new Error('必须且只能提供一种 upload-ticket 或旧版 upload-session 输入')
    }
    const option = selected[0]
    const ticketMode = option.startsWith('upload-ticket')
    const authInput = option.endsWith('-stdin') ? await readUploadInputFromStdin() : args[option]
    if (ticketMode) {
      if (args['file-name'] !== undefined) throw new Error('票据上传不支持 --file-name，使用本地文件名')
      files = parseUploadFiles(args)
      if (args['finalize-vid'] !== undefined && (files.length !== 1 || classifyUploadKind(files[0].file) === 'image')) {
        throw new Error('票据 finalize 重试必须提供一个原视频或音频文件')
      }
      session = await fetchUploadSession(authInput, files, connectTimeout)
    } else {
      if (typeof authInput !== 'string' || !authInput) throw new Error('缺少完整 upload session JSON')
      session = parseResponseJSON(authInput, 'upload-session')
    }
    if (args['finalize-vid'] !== undefined) {
      if (!ticketMode && (args.file !== undefined || args.files !== undefined)) {
        throw new Error('旧版 --finalize-vid 不能与 --file 或 --files 同时使用')
      }
      resultFileFD = openResultFile(args)
      let output
      try {
        output = await runFinalizeOnly(args, session)
      } catch (err) {
        if (resultFileFD !== null) {
          fs.closeSync(resultFileFD)
          fs.rmSync(args['result-file'], { force: true })
        }
        throw err
      }
      try {
        outputResult(args, output, resultFileFD)
      } catch (err) {
        log(err.message)
        process.exit(2)
      }
      process.exit(output.success ? 0 : 1)
    }
    files = files || parseUploadFiles(args)
    configs = buildUploadConfigs(args, files, session)
  } catch (err) {
    const errors = [`参数解析失败: ${err.message}`]
    if (args.json) {
      process.stdout.write(JSON.stringify({ success: false, errors }) + '\n')
    } else {
      log('参数错误:\n  - ' + errors.join('\n  - '))
    }
    process.exit(2)
  }

  const errors = configs.flatMap((cfg) => validate(cfg).map((error) => `${cfg.file}: ${error}`))
  if (errors.length > 0) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ success: false, errors }) + '\n')
    } else {
      log('参数错误:\n  - ' + errors.join('\n  - '))
    }
    process.exit(2)
  }

  try {
    resultFileFD = openResultFile(args)
  } catch (err) {
    if (args.json) process.stdout.write(JSON.stringify({ success: false, errors: [err.message] }) + '\n')
    else log(err.message)
    process.exit(2)
  }

  const results = new Array(configs.length)
  let nextFile = 0
  log(`开始上传 ${configs.length} 个文件，文件并发 ${Math.min(fileParallel, configs.length)}`)
  // 文件任务各自收尾，失败不会取消同批其他文件；结果按输入索引写入。
  const worker = async () => {
    while (nextFile < configs.length) {
      const index = nextFile++
      const cfg = configs[index]
      await uploadLogContext.run(cfg.clientId || path.basename(cfg.file), async () => {
        const started = Date.now()
        log(`开始文件 ${index + 1}/${configs.length}: ${path.basename(cfg.file)}`)
        try {
          results[index] = await uploadOne(cfg)
        } catch (err) {
          log(`上传失败: ${err.message}`)
          results[index] = { success: false, file: cfg.file, clientId: cfg.clientId, kind: cfg.kind, error: err.message }
        }
        const result = results[index]
        const stats = cfg.stats
        // 并发请求/等待耗时为累加值；重试字节是请求体大小，非实际网络传输计量。
        log(`文件结束 success=${result.success}, elapsed_ms=${Date.now() - started}, confirmed_bytes=${stats.confirmedBytes}, retry_body_bytes=${stats.retryBodyBytes}, retry_count=${stats.retryCount}, data_request_ms_sum=${stats.requestMs}, retry_wait_ms_sum=${stats.retryWaitMs}, read_crc_ms_sum=${stats.readCrcMs}, buffer_wait_ms_sum=${stats.bufferWaitMs}${result.vid ? `, vid=${result.vid}` : ''}${result.uri ? `, uri=${result.uri}` : ''}`)
      })
    }
  }
  await Promise.all(Array.from({ length: Math.min(fileParallel, configs.length) }, () => worker()))

  const success = results.every((result) => result.success)
  const output = args.files === undefined ? results[0] : { success, results }
  try {
    outputResult(args, output, resultFileFD)
  } catch (err) {
    log(err.message)
    process.exit(2)
  }
  process.exit(success ? 0 : 1)
}

main()
