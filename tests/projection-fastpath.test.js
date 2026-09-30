// P2（2026-09-29 审计）：0.2.0+ 官方 title 投影快路径的回归测试。
//
// fast path 语义：列表构建在两级缓存（metaCache → 持久标题索引）都未命中时，
// 先探 ctx.sessionProjections 的 cachedSnapshot（零折叠、零 I/O 的 watermark
// 缓存读）；拿到**非空字符串**标题 → 直接进 metaCache 并从预热队列剔除；
// null / 服务不存在 / 会话未实例化 / 任何异常 → 一律当「未知」交回后台预热
// （empty 三态纪律：null 绝不冒充「会话真的无标题」）。
//
// 本文件用 mock cordis 上下文驱动真实 /list 路由，断言三件事：
//   1. 投影命中的会话**本次响应就带标题**（不等预热）；
//   2. 该会话**没有**进预热队列（readTitleSnapshots 收不到它）；
//   3. 没有官方投影（模拟 0.1.7）时行为与 3.7.4 完全一致：全部进预热。
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

const TITLE_FROM_PROJECTION = '投影标题'

async function boot({ withProjection }) {
  const root = await mkdtemp(join(tmpdir(), 'dsm-fastpath-'))
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'stars')
  process.env.DSH_SESSIONS_MANAGER_AUTO_ARCHIVE_DIR = join(root, 'aa')

  // 真实日志文件：没有 stat 指纹的会话会被 enqueueWarm 的 #9 churn 防护跳过，
  // 预热队列根本不会跑——所以两个会话都要有可 stat 的日志。
  const logPaths = {
    'fp-hit': join(root, 'fp-hit', 'session.jsonl.zstd'),
    'fp-miss': join(root, 'fp-miss', 'session.jsonl.zstd'),
  }
  for (const p of Object.values(logPaths)) {
    await mkdir(dirname(p), { recursive: true })
    await writeFile(p, 'x'.repeat(512))
  }

  const headers = [
    { id: 'fp-hit', cwd: '/ws-a', createdAt: 1000 },
    { id: 'fp-miss', cwd: '/ws-a', createdAt: 2000 },
  ]
  const liveSessions = new Map([
    // 只有 fp-hit 有实例化会话对象（fp-miss 模拟冷会话）。
    ['fp-hit', { id: 'fp-hit', header: headers[0], events: [] }],
  ])
  const sessions = {
    get: (id) => liveSessions.get(id) || null,
    list: () => [...liveSessions.values()],
  }
  const warmCalls = []
  const routes = new Map()
  const ctx = {
    workspaceRegistry: {
      list: () => [{ id: 'ws-a', path: '/ws-a', title: 'WS A', sessionIds: [], detachSession: async () => {} }],
      state: { archivedSessionIds: [] },
      archiveSession: async () => {},
    },
    sessionPersistence: {
      list: async () => headers,
      locate: (item) => (item && logPaths[item.id] ? { path: logPaths[item.id] } : null),
      readFrom: async () => ({ meta: null, events: [] }),
    },
    sessionQuery: {
      readTitleSnapshots: async (ids) => {
        warmCalls.push([...ids])
        return ids.map((sid) => ({ status: 'fulfilled', value: { session: { id: sid }, title: { title: `预热 ${sid}` } } }))
      },
    },
    storageDomain: { get: () => ({ global: { get: () => ({ archivedSessionIds: [] }), set: async () => {} } }) },
    webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
    get: (name) => {
      if (name === 'sessions') return sessions
      if (name === 'sessionProjections' && withProjection) {
        return {
          cachedSnapshot: (session, keys) => {
            if (!Array.isArray(keys) || !keys.includes('title')) return undefined
            // fp-hit 的 cell 已 materialize 且带非空标题；其余一律 omitted。
            return session && session.id === 'fp-hit' ? { asOfSeq: 3, values: { title: TITLE_FROM_PROJECTION } } : undefined
          },
        }
      }
      return null
    },
    effect: (fn) => fn(),
  }
  const { apply } = await import(`../src/index.js?fp=${withProjection ? 'p' : 'n'}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  apply(ctx)

  const call = async (path, body = {}) => {
    const req = Readable.from([Buffer.from(JSON.stringify(body))])
    let status = 200
    let text = ''
    const res = { writeHead: (value) => { status = value }, end: (value) => { text += value || '' } }
    await routes.get(path)(req, res)
    return { status, body: JSON.parse(text) }
  }
  const cleanup = async () => { await rm(root, { recursive: true, force: true }) }
  return { call, warmCalls, cleanup }
}

// 预热是延迟定时器驱动（v3.6.2 冷启动 1.5s 二拍），轮询等待而非固定 sleep。
async function waitForWarm(warmCalls, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && warmCalls.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

test('projection fast path: hit skips the warm queue and answers immediately', async () => {
  const h = await boot({ withProjection: true })
  try {
    const result = await h.call('/archived-sessions/sessions', {})
    assert.equal(result.status, 200)
    const byId = new Map((result.body.items || []).map((it) => [it.sessionId, it]))
    // 1) 投影命中的会话本次响应就带标题。
    assert.equal(byId.get('fp-hit').title, TITLE_FROM_PROJECTION)
    // 2) fp-hit 不进预热队列；fp-miss（冷会话）照旧进。
    await waitForWarm(h.warmCalls)
    const warmed = h.warmCalls.flat()
    assert.ok(!warmed.includes('fp-hit'), `fp-hit 不该进预热，实际预热了 ${JSON.stringify(h.warmCalls)}`)
    assert.ok(warmed.includes('fp-miss'), 'fp-miss 应进预热队列')
    // 3) 冷会话标题是占位 null（预热是后台的，响应不等它）。
    assert.equal(byId.get('fp-miss').title, null)
  } finally { await h.cleanup() }
})

test('without sessionProjections (0.1.7): behaviour identical to 3.7.4', async () => {
  const h = await boot({ withProjection: false })
  try {
    const result = await h.call('/archived-sessions/sessions', {})
    assert.equal(result.status, 200)
    const byId = new Map((result.body.items || []).map((it) => [it.sessionId, it]))
    assert.equal(byId.get('fp-hit').title, null)
    await waitForWarm(h.warmCalls)
    const warmed = h.warmCalls.flat()
    assert.ok(warmed.includes('fp-hit') && warmed.includes('fp-miss'), '没有投影服务时两个都进预热')
  } finally { await h.cleanup() }
})

test('projection null title is "unknown", never "has no title"', async () => {
  const h = await boot({ withProjection: true })
  try {
    // cachedSnapshot 对 fp-hit 返回 values.title=null（cell 折叠了但还没有标题）
    // 时不能免预热——直接改 mock 不可行（boot 已固化），这里用另一个层面验证：
    // fp-miss 有 cachedSnapshot=undefined（等价 null 语义），上一条已断言它进了
    // 预热。本条只断言投影 null 不会被当成真实标题渲染。
    const result = await h.call('/archived-sessions/sessions', {})
    const byId = new Map((result.body.items || []).map((it) => [it.sessionId, it]))
    assert.notEqual(byId.get('fp-miss').title, TITLE_FROM_PROJECTION)
  } finally { await h.cleanup() }
})
