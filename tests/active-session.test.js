// 活跃会话探测回归。
//
// 背景（0.1.7 / 0.2.0）：host 进程里没有 activeSession / currentSession /
// sessions.active 任何一个访问器——「用户正在看哪个会话」只有客户端知道。此前
// host 侧三个探测全部落空 → getActiveSessionId 恒 null → 两条保护形同虚设：
//   * 移动活跃会话的 409（本应「请切走再移动」/排队，实际直接动盘）
//   * 自动归档跳过当前会话（用户正在看的会话会被归档掉）
// 修法：客户端周期性上报当前会话 id，host 只在心跳新鲜期内采信。
//
// 本文件三层覆盖：
//   1) tracker 的时间语义（TTL / 多端分桶 / 空值清除 / 桶数上限）——注入时钟，
//      不靠真实 sleep；
//   2) 通过真实 host 路由的端到端：上报 → 自动归档跳过该会话（storage-route
//      同款 fixture，mtime 就是真实的活跃信号）；
//   3) 静态守卫：客户端新增移动入口时，若忘了先同步活跃会话就红。
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Readable } from 'node:stream'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import { createActiveSessionTracker, DEFAULT_ACTIVE_TTL_MS, MAX_ACTIVE_REPORTS } from '../src/active-session.js'
import { pickInactiveCandidates } from '../src/auto-archive.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = readFileSync(join(root, 'src/index.js'), 'utf8')
const CLIENT = readFileSync(join(root, 'src/client/index.jsx'), 'utf8')

// ---- 1) tracker 时间语义 ------------------------------------------------------

test('reported active session expires after the TTL (no stale lock-out)', () => {
  let now = 1_000
  const tracker = createActiveSessionTracker({ ttlMs: DEFAULT_ACTIVE_TTL_MS, now: () => now })
  tracker.report('browser', 's-1')
  assert.deepEqual([...tracker.activeIds()], ['s-1'])
  now += DEFAULT_ACTIVE_TTL_MS - 1
  assert.deepEqual([...tracker.activeIds()], ['s-1'], 'TTL 内必须仍然生效')
  now += 2
  assert.deepEqual([...tracker.activeIds()], [], '心跳过期后必须失效：否则会话会被永久锁死')
})

test('several clients keep their own active session', () => {
  const tracker = createActiveSessionTracker({ ttlMs: 60_000 })
  tracker.report('browser', 's-a')
  tracker.report('desktop', 's-b')
  assert.deepEqual([...tracker.activeIds()].sort(), ['s-a', 's-b'])
  // 其中一个客户端切走/关闭：只掉它自己的那一票。
  tracker.report('browser', null)
  assert.deepEqual([...tracker.activeIds()], ['s-b'])
})

test('empty / missing sessionId clears the slot instead of keeping the old one', () => {
  const tracker = createActiveSessionTracker({ ttlMs: 60_000 })
  tracker.report('browser', 's-1')
  assert.equal(tracker.size, 1)
  for (const empty of [null, undefined, '']) {
    tracker.report('browser', empty)
    assert.deepEqual([...tracker.activeIds()], [])
  }
})

test('junk session ids are rejected and never enter the tracker', () => {
  const tracker = createActiveSessionTracker({ ttlMs: 60_000 })
  const junk = ['a/b', 'x'.repeat(300), 'nul\0byte', 42, {}]
  for (const value of junk) {
    assert.equal(tracker.report('browser', value), false, `必须拒绝 ${String(value)}`)
  }
  assert.equal(tracker.size, 0)
})

test('report buckets stay bounded', () => {
  const tracker = createActiveSessionTracker({ ttlMs: 60_000 })
  for (let i = 0; i < MAX_ACTIVE_REPORTS + 50; i++) tracker.report(`client-${i}`, `s-${i}`)
  assert.ok(tracker.size <= MAX_ACTIVE_REPORTS, `桶数必须封顶，实际 ${tracker.size}`)
})

// ---- auto-archive 接过「多个活跃会话」---------------------------------------

test('pickInactiveCandidates skips every reported active session', () => {
  const now = Date.now()
  const items = [
    { sessionId: 'old-1', updatedAt: now - 100 * 86400000 },
    { sessionId: 'old-2', updatedAt: now - 100 * 86400000 },
    { sessionId: 'new-1', updatedAt: now },
  ]
  assert.deepEqual(pickInactiveCandidates(items, { inactiveDays: 30, activeSessionIds: ['old-1', 'old-2'], now }), [])
  assert.deepEqual(pickInactiveCandidates(items, { inactiveDays: 30, activeSessionIds: ['old-1'], now }), ['old-2'])
  // 旧的单值入参继续有效（back-compat）。
  assert.deepEqual(pickInactiveCandidates(items, { inactiveDays: 30, activeSessionId: 'old-1', now }), ['old-2'])
  assert.deepEqual(pickInactiveCandidates(items, { inactiveDays: 30, now }), ['old-1', 'old-2'])
})

// ---- 2) 端到端：上报 → host 路由 → 自动归档跳过 -------------------------------

const DAY = 86400000
let tmp
let routes
let domainState
const cleanups = []

before(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'dsm-active-'))
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(tmp, 'trash')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(tmp, 'pending')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(tmp, 'stars')
  process.env.DSH_SESSIONS_MANAGER_AUTO_ARCHIVE_DIR = join(tmp, 'aa')
  await mkdir(process.env.DSH_SESSIONS_MANAGER_TRASH_DIR, { recursive: true })

  const logPaths = {
    'old-1': join(tmp, 'old-1', 'session.jsonl.zstd'),
    'old-2': join(tmp, 'old-2', 'session.jsonl.zstd'),
  }
  for (const p of Object.values(logPaths)) await mkdir(dirname(p), { recursive: true })
  await writeFile(logPaths['old-1'], 'x'.repeat(1000), 'utf8')
  await writeFile(logPaths['old-2'], 'y'.repeat(1000), 'utf8')
  const frozen = (Date.now() - 100 * DAY) / 1000
  await utimes(logPaths['old-1'], frozen, frozen)
  await utimes(logPaths['old-2'], frozen, frozen)

  const wsPath = join(tmp, 'ws-a')
  await mkdir(wsPath, { recursive: true })
  const headers = [
    { id: 'old-1', cwd: wsPath, title: 'Old one', createdAt: Date.now() - 100 * DAY },
    { id: 'old-2', cwd: wsPath, title: 'Old two', createdAt: Date.now() - 100 * DAY },
  ]
  domainState = { archivedSessionIds: [] }
  routes = new Map()

  const ctx = {
    workspaceRegistry: {
      list: () => [{ id: 'ws-a', path: wsPath, title: 'A', sessionIds: ['old-1', 'old-2'], detachSession: async () => {} }],
      state: domainState,
      archiveSession: async (sid) => { if (!domainState.archivedSessionIds.includes(sid)) domainState.archivedSessionIds.push(sid) },
    },
    sessionPersistence: {
      list: async () => headers,
      locate: (item) => (item && logPaths[item.id] ? { path: logPaths[item.id] } : null),
      readFrom: async (sid) => ({ meta: headers.find((h) => h.id === sid) || null, events: [] }),
    },
    sessionQuery: {
      readTitleSnapshots: async (ids) => ids.map((sid) => {
        const h = headers.find((x) => x.id === sid)
        return { status: 'fulfilled', value: h ? { session: h, title: { title: h.title } } : null }
      }),
    },
    storageDomain: { get: () => ({ global: { get: () => domainState, set: async (next) => Object.assign(domainState, next) } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    // 关键：0.2.0 的 host 侧这三个访问器一个都不存在（get 恒 null），
    // 只有客户端上报能给出活跃会话。
    get: () => null,
    // cordis 约定：effect(fn) 立即执行 fn，fn 的返回值是清理函数。这里必须
    // 收集起来在 after 里执行——否则启动补跑定时器（0/1/3/6/12/30s，写
    // pending 状态）在 after 的 rm 期间仍会开火，间歇性 ENOTEMPTY（CI 实测）。
    effect: (fn) => { const r = fn(); if (typeof r === 'function') cleanups.push(r) },
  }
  const { apply } = await import(`../src/index.js?active=${Date.now()}`)
  apply(ctx)
})

after(async () => {
  for (const c of cleanups.splice(0)) { try { await c() } catch (e) { /* 尽力清理 */ } }
  // maxRetries 兜底：仍有一个性子慢的异步写入踩进 rm 窗口时重试而非失败。
  await rm(tmp, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

async function call(path, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  let status = 200
  let text = ''
  const res = { writeHead: (value) => { status = value }, end: (value) => { text += value || '' } }
  await routes.get(path)(req, res)
  return { status, body: JSON.parse(text) }
}

async function enableAutoArchive(days) {
  await call('/archived-sessions/auto-archive/settings', { inactiveDays: days, skipStarred: true })
}

test('heartbeat route records and clears the active session', async () => {
  const reported = await call('/archived-sessions/active-session', { clientId: 'browser', sessionId: 'old-1' })
  assert.equal(reported.status, 200)
  assert.deepEqual(reported.body.activeSessionIds, ['old-1'])
  const cleared = await call('/archived-sessions/active-session', { clientId: 'browser', sessionId: null })
  assert.deepEqual(cleared.body.activeSessionIds, [])
})

test('auto-archive skips the session the client reports as open', async () => {
  await enableAutoArchive(30)
  domainState.archivedSessionIds = []
  await call('/archived-sessions/active-session', { clientId: 'browser', sessionId: 'old-1' })
  const run = await call('/archived-sessions/auto-archive/run', { force: true })
  assert.equal(run.status, 200, run.body.error)
  // 没有客户端上报时两个都会归档；上报 old-1 为活跃后它必须被留下。
  assert.deepEqual(domainState.archivedSessionIds, ['old-2'])
})

test('with no heartbeat the sweep archives both (never locks a session forever)', async () => {
  await enableAutoArchive(30)
  domainState.archivedSessionIds = []
  await call('/archived-sessions/active-session', { clientId: 'browser', sessionId: null })
  const run = await call('/archived-sessions/auto-archive/run', { force: true })
  assert.equal(run.status, 200, run.body.error)
  assert.deepEqual(domainState.archivedSessionIds.sort(), ['old-1', 'old-2'])
})

// ---- 3) 静态守卫 -------------------------------------------------------------

test('host registers the active-session heartbeat route', () => {
  assert.ok(
    HOST.includes("path: '/archived-sessions/active-session'"),
    'host 必须提供 /archived-sessions/active-session，否则客户端上报无处可去',
  )
})

test('every client move entry syncs the active session first', () => {
  for (const route of ["'/archived-sessions/move'", "'/archived-sessions/move-many'"]) {
    assert.ok(
      CLIENT.includes(`postActiveAware(${route}`),
      `移动入口 ${route} 必须走 postActiveAware（先同步活跃会话），否则 host 会拿旧值放行`,
    )
    assert.ok(
      !CLIENT.includes(`postJSON(${route}`),
      `移动入口 ${route} 不应再裸调 postJSON：绕过了活跃会话同步`,
    )
  }
})

test('client probes its own active session and reports it', () => {
  assert.ok(CLIENT.includes('function dsmActiveSessionId'), '客户端必须有活跃会话探测')
  assert.ok(
    CLIENT.includes("'/archived-sessions/active-session'"),
    '客户端必须把探测结果上报给 host',
  )
  assert.ok(
    /reportActiveSession\(false\)/.test(CLIENT),
    '必须有周期性心跳（force=false），否则 host 侧 TTL 到期后保护失效',
  )
})
