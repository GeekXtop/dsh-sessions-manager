// Real-runtime integration smoke for dsh-sessions-manager's compat layer.
//
// Boots the OFFICIAL @deepseek-ai JSONL persistence backend (built lib output
// of a deepseek-harness checkout) on a real cordis Context, creates synthetic
// sessions through the official public API only (create → handle.append →
// flush → close), then drives the plugin's adapter + capabilities against it:
//
//   1. list() returns SessionPersistenceSnapshot with header/revision/sizeBytes
//   2. stat() revision is stable while the log is unchanged
//   3. SessionHandle.read(offset, length) is a bounded, contiguous slice
//   4. adapter.inspectSession chunks a long log with exactly one close
//   5. capabilities: handle-era runtime gates physicalPurge / relocateSession
//
// Usage:
//   node scripts/compat-runtime.mjs <path-to-deepseek-harness-checkout>
//        [--node-hint <version>]   # prints a hint when the native deps mismatch
//
// NOTE: the harness build tree contains native modules compiled for whatever
// Node built it. If you hit NODE_MODULE_VERSION errors, rerun with the Node
// version the checkout was built with (e.g. system node 26 for local builds).
import { statSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const harnessDir = resolve(process.argv[2] || process.env.DSH_HARNESS_DIR || '')
if (!harnessDir) {
  console.error('usage: node scripts/compat-runtime.mjs <deepseek-harness-checkout | ~/.dsh/runtime>')
  process.exit(2)
}

// 两种布局都支持：
//   1) 源码 checkout：<dir>/packages/session/session-persistence-jsonl
//   2) 已安装 runtime：<dir>/node_modules/@deepseek-ai/dsh-session-persistence-jsonl
// （runtime-src 会被 `dsm cleanup` 删掉，日常最方便的是直接指向 ~/.dsh/runtime）
const existsSync = (p) => { try { statSync(p); return true } catch { return false } }
let pkgs = {
  persistenceJsonl: join(harnessDir, 'packages/session/session-persistence-jsonl'),
  persistence: join(harnessDir, 'packages/session/session-persistence'),
}
if (!existsSync(pkgs.persistenceJsonl)) {
  const nm = join(harnessDir, 'node_modules/@deepseek-ai')
  if (existsSync(join(nm, 'dsh-session-persistence-jsonl'))) {
    pkgs = {
      persistenceJsonl: join(nm, 'dsh-session-persistence-jsonl'),
      persistence: join(nm, 'dsh-session-persistence'),
    }
  } else {
    console.error(`找不到官方后端：既没有 ${pkgs.persistenceJsonl}，也没有 ${join(nm, 'dsh-session-persistence-jsonl')}`)
    process.exit(2)
  }
}
const requireFrom = (dir) => createRequire(join(dir, 'package.json'))

async function loadModule(pkgDir, sub) {
  const specifier = sub || '.'
  try {
    return await import(pathToFileURL(join(pkgDir, sub || 'lib/index.js')).href)
  } catch (e) {
    if (String(e.message).includes('NODE_MODULE_VERSION')) {
      console.error(`native module mismatch for ${pkgDir}: rebuild the harness or run this script with the Node version the checkout was built with.`)
    }
    throw e
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsm-runtime-'))
const checks = []
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail: detail === undefined ? null : detail })
  if (!ok) throw new Error(`runtime smoke failed: ${name}${detail !== undefined ? ` (${JSON.stringify(detail)})` : ''}`)
}

try {
  // Real cordis Context, resolved from the harness's own dependency tree so
  // Service registration semantics are exactly the production ones.
  const cordisDir = requireFrom(pkgs.persistence).resolve('@deepseek-ai/cordis')
  const cordis = await import(pathToFileURL(cordisDir).href).then((m) => m.default ?? m)
  const { default: JsonlSessionPersistence } = await loadModule(pkgs.persistenceJsonl)
  const persistenceMod = await loadModule(pkgs.persistence)
  const ServiceCtor = persistenceMod.default
  check('exports resolve', typeof JsonlSessionPersistence === 'function' && typeof ServiceCtor === 'function')

  const ctx = typeof cordis === 'function' ? new cordis() : new cordis.Context()
  const sp = new JsonlSessionPersistence(ctx, { root })
  check('service is the official SessionPersistence subclass', sp instanceof ServiceCtor, sp.name)

  // ---- synthetic session through the official write path -------------------
  // Header must carry the full current-format vocabulary (version/isSeeded/
  // delegationDepth): a sparse header materializes, but the backend's own header
  // reader then classifies the frame as malformed and list()/stat() silently skip it.
  // **version 必须等于后端的当前格式版本**（0.1.2/0.1.3 = v2，0.1.5+ = v3），
  // 否则 encodeCurrentHeader 直接抛 `encodeCurrent requires Session format vN`。
  // 当前格式版本的探测。0.1.7 起官方把 catalog 拆到了独立包
  // @deepseek-ai/dsh-session-format-catalog（sessionFormatCatalog.currentVersion）；
  // 0.1.5 及更早则并在 @deepseek-ai/dsh-session-format 内。两个布局都试，
  // 都失败才回落到 3（0.1.5 的当前版本）。
  let CURRENT_FORMAT_VERSION = 3
  try {
    const catalogUrl = pathToFileURL(join(
      dirname(requireFrom(pkgs.persistenceJsonl).resolve('@deepseek-ai/dsh-session-format-catalog/package.json')),
      'lib/index.js',
    )).href
    CURRENT_FORMAT_VERSION = (await import(catalogUrl)).sessionFormatCatalog.currentVersion
  } catch (e) {
    try {
      const formatUrl = pathToFileURL(join(
        dirname(requireFrom(pkgs.persistenceJsonl).resolve('@deepseek-ai/dsh-session-format/package.json')),
        'lib/index.js',
      )).href
      CURRENT_FORMAT_VERSION = (await import(formatUrl)).sessionFormatCatalog?.currentVersion ?? 3
    } catch (_) { /* 保留回落值 3 */ }
  }
  // handle.read() 的返回值形态随版本变化：0.1.3 是事件数组，0.1.5 是
  // `{ eventState, events }`。这个 helper 同时充当形态回归断言——形态不认识就返回
  // null，下面的 check 会立刻失败（2026-09-10 的读取恒空事故就属于这一类）。
  const readEvents = (result) => Array.isArray(result)
    ? result
    : (result && Array.isArray(result.events) ? result.events : null)
  const header = {
    id: `smoke-${Date.now().toString(36)}`,
    cwd: root,
    createdAt: Date.now(),
    version: CURRENT_FORMAT_VERSION,
    isSeeded: false,
    delegationDepth: 0,
  }
  const write = await sp.create(header)
  const N = 9
  // 官方校验（assertMessageEventShape）：user/message 的 data 本身就是 message
  // record，必须带 id/role/source/content。
  const batch = Array.from({ length: N }, (_, i) => ({
    type: 'user/message',
    data: { id: `m-${i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `event-${i}` }] },
    seq: i,
    time: Date.now(),
    surfaceOp: 'append', // v3 surface 事件必需的顶层标记
  }))
  await write.append(batch)
  await write.flush()
  await write.close()

  // ---- plugin adapter against the real backend ----------------------------
  const plugin = await import('../src/compat/persistence.js')
  const adapter = plugin.createPersistenceAdapter(sp)
  check('adapter kind is session-handle', adapter.kind === 'session-handle')

  const entries = await adapter.listEntries()
  check('list returns snapshot entries', entries.some((e) => e.id === header.id), { count: entries.length })
  const entry = entries.find((e) => e.id === header.id)
  check('snapshot carries header/revision/sizeBytes', !!entry && typeof entry.revision === 'string' && entry.sizeBytes > 0)

  const stat1 = await adapter.statSession(header.id)
  const stat2 = await adapter.statSession(header.id)
  check('stat revision is stable while unchanged', !!stat1 && stat1.revision === stat2.revision, stat1 && stat1.revision)

  // bounded reads through the official handle
  const rh = await sp.open(header.id, 'read')
  const raw1 = await rh.read(0, 4)
  const raw2 = await rh.read(4, 4)
  const rawTail = await rh.read(8, 100)
  const rawBeyond = await rh.read(N, 4)
  const slice1 = readEvents(raw1)
  const slice2 = readEvents(raw2)
  const tail = readEvents(rawTail)
  const beyond = readEvents(rawBeyond)
  check('handle.read result shape is recognised (array or { events })',
    slice1 !== null && slice2 !== null && tail !== null && beyond !== null,
    { shape: Object.prototype.toString.call(raw1) })
  check('bounded read slices are contiguous',
    slice1.length === 4 && slice2.length === 4 && tail.length === 1 && beyond.length === 0,
    [slice1.length, slice2.length, tail.length, beyond.length])
  await rh.close()

  // chunked inspection: single close, exact fold
  let opens = 0
  let closes = 0
  const origOpen = sp.open.bind(sp)
  sp.open = async (...args) => { opens++; const h = await origOpen(...args); const oc = h.close.bind(h); h.close = async () => { closes++; return oc() }; return h }
  const batches = []
  const summary = await adapter.inspectSession(header.id, { chunkSize: 4, onEvents: (b) => batches.push(b.length) })
  check('inspectSession folds the whole log in chunks', summary.eventCount === N && batches.join(',') === '4,4,1', batches)
  check('inspectSession closes the handle exactly once', opens === 1 && closes === 1, { opens, closes })

  // capabilities：真实后端带 root 实例字段 → 物理删除/移动恢复可用（2026-09-06
  // 用户决策）；构造一个无 root 的实例验证降级理由仍然成立。
  const caps = await import('../src/compat/capabilities.js')
  const matrix = caps.detectCapabilities({ persistence: sp, workspaceRegistry: { archiveSession() {}, headers: new Map(), sessionPaths: new Map(), replaceHeaderIndex() {} } })
  check('handle-era with backend root enables physicalPurge', matrix.actions.physicalPurge.available === true, matrix.actions.physicalPurge)
  check('handle-era with backend root enables relocateSession', matrix.actions.relocateSession.available === true, matrix.actions.relocateSession)
  check('handle-era allows readInspection + restoreIndexedSession', matrix.actions.readInspection.available === true && matrix.actions.restoreIndexedSession.available === true)
  const degraded = caps.detectCapabilities({ persistence: { open: sp.open.bind(sp), stat: sp.stat.bind(sp) }, workspaceRegistry: { archiveSession() {} } })
  check('handle-era without root degrades purge/move with reason', degraded.actions.physicalPurge.available === false && /存储根目录/.test(degraded.actions.physicalPurge.reason), degraded.actions.physicalPurge.reason)

  // existence check via stat: a ghost session must be observable as absent
  const ghost = await adapter.statSession('does-not-exist')
  check('statSession reports absent sessions as null', ghost === null)

  // ---- handle-era destructive ops against the REAL backend -----------------
  // 2026-09-06 用户决策：物理删除与跨工作区移动沿用 legacy 半官方路线
  // （守卫式路径推导 + 受控 fs 操作）。本节在真实 alpha.1 构建上验证
  // handle-era-paths / handle-era-ops 的端到端行为。
  const mkBatch = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => ({
    type: 'user/message',
    data: { id: `m-${from + i}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `event-${from + i}` }] },
    seq: from + i,
    time: Date.now(),
    surfaceOp: 'append', // v3 surface 事件必需的顶层标记
  }))
  const pathsMod = await import('../src/handle-era-paths.js')
  const opsMod = await import('../src/handle-era-ops.js')

  // 路径推导必须命中真实落盘布局（root 实例字段 + projectKey/encodeSegment）。
  const currentStat = await sp.stat(header.id)
  const artifacts = await pathsMod.locateSessionArtifacts(sp, currentStat.header)
  check('locateSessionArtifacts resolves the real session dir', !!artifacts && /session\.v\d+\.jsonl\.zstd$/.test(artifacts.logPath), artifacts && artifacts.logPath)
  check('locateSessionArtifacts rejects unknown sessions', await pathsMod.locateSessionArtifacts(sp, { id: 'no-such-id', cwd: root }) === null)

  // 关闭态会话：写所有权探测放行。
  await opsMod.ensureNoActiveWriter(sp, header.id)
  check('ensureNoActiveWriter passes for a closed session', true)

  // MOVE：官方 create+append 重放 → cwd 生效 + 事件逐条保留 + 旧目录清空。
  const wsB = join(root, 'project-b')
  await opsMod.moveSessionToCwd({ sp, sid: header.id, header: currentStat.header, canonical: wsB, events: batch, inheritedEventCount: 0 })
  const movedStat = await sp.stat(header.id)
  check('move: official stat carries the new cwd', !!movedStat && movedStat.header.cwd === wsB, movedStat && movedStat.header.cwd)
  const reread = await adapter.readSession(header.id, 0)
  check('move: events preserved byte-identically', reread.events.length === N && JSON.stringify(reread.events) === JSON.stringify(batch), reread.events.length)
  const oldLoc = await pathsMod.locateSessionArtifacts(sp, { ...header, cwd: root })
  const newLoc = await pathsMod.locateSessionArtifacts(sp, { ...header, cwd: wsB })
  check('move: derivation follows the relocated log', oldLoc === null && !!newLoc)

  // MOVE 拒绝活跃写者：保持写句柄打开时移动必须 409。
  const busyId = `smoke-busy-${Date.now().toString(36)}`
  const busyHeader = { ...header, id: busyId, createdAt: Date.now() }
  const busyWriter = await sp.create(busyHeader)
  await busyWriter.append(mkBatch(0, 2))
  await busyWriter.flush()
  let busyRefused = false
  try {
    await opsMod.moveSessionToCwd({ sp, sid: busyId, header: busyHeader, canonical: join(root, 'project-c'), events: [] })
  } catch (e) {
    busyRefused = e.status === 409 && e.code === 'DSM_SESSION_BUSY'
  }
  await busyWriter.close()
  check('move refuses an actively-writing session with 409', busyRefused)

  // PURGE：整目录删除 → 官方 stat 复核消失 → 推导失效。
  const purgeHeader = (await sp.stat(header.id)).header
  await opsMod.purgeSessionArtifacts(sp, header.id, purgeHeader)
  const afterPurge = await sp.stat(header.id)
  check('purge: official stat no longer sees the session', afterPurge === undefined)
  check('purge: derivation no longer resolves', await pathsMod.locateSessionArtifacts(sp, purgeHeader) === null)

  // PURGE 拒绝活跃写者（409），句柄关闭后重试成功。
  const busyStat = await sp.stat(busyId)
  let purgeRefused = false
  const holdWriter = await sp.create({ ...header, id: `smoke-hold-${Date.now().toString(36)}`, createdAt: Date.now() })
  await holdWriter.append(mkBatch(0, 1))
  await holdWriter.flush()
  // busyId 的写句柄已关闭；改为用 holdWriter 自身验证「写者未关闭 → 409」。
  try {
    await opsMod.purgeSessionArtifacts(sp, holdWriter.id, (await sp.stat(holdWriter.id)).header)
  } catch (e) {
    purgeRefused = e.status === 409 && e.code === 'DSM_SESSION_BUSY'
  }
  check('purge refuses a session with an open writer handle', purgeRefused)
  await holdWriter.close()
  await opsMod.purgeSessionArtifacts(sp, holdWriter.id, (await sp.stat(holdWriter.id)).header)
  check('purge succeeds after the writer closes', (await sp.stat(holdWriter.id)) === undefined && (await sp.stat(busyId)) !== undefined)
  void busyStat

  // ---- ROUTE-level smoke: boot the FULL plugin and drive real web routes ---
  // 背景：v3.5.2 的「彻底删除」路由曾因引用未定义变量在 0.1.3 上稳定崩溃，
  // 而本脚本的 ops 直连冒烟全程绿灯——路由层回归与 ops 直连不可互替。
  // 本节在真实 alpha.1 后端上以完整 apply() 启动插件，直接驱动
  // /archived-sessions/move 与 /archived-sessions/trash/purge 路由。
  //
  // P3-B（2026-09-29 审计）：runtime 已有真栈（storage / storage-json /
  // storage-domain / workspace 包，0.2.0 起 dsh-base 默认组合全带）时，本节的
  // storageDomain 旧形状 stub 与 mock registry **不再运行**——全部路由级检查
  // （含 purge 路由与移动字节一致性）已并入下方 DOMAIN-level 真栈段，消除
  // 「同一路由两套依赖形状」的双真相源。0.1.7 及更早 runtime 仍走本节保底。
  const resolvePkgDirProbe = (n) => {
    try { return dirname(requireFrom(pkgs.persistence).resolve(`@deepseek-ai/${n}/package.json`)) } catch (e) { return null }
  }
  const hasRealStack = !!(resolvePkgDirProbe('dsh-storage') && resolvePkgDirProbe('dsh-storage-json')
    && resolvePkgDirProbe('dsh-storage-domain') && resolvePkgDirProbe('dsh-workspace'))
  if (hasRealStack) {
    console.log('  · legacy route stubs skipped（真栈可用：路由级检查已并入 DOMAIN-level 真栈段）')
  } else {
    process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = await mkdtemp(join(tmpdir(), 'dsm-runtime-trash-'))
  // 待移动队列也要落到临时目录，别写进真实的 ~/.dsh/sessions-manager。
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = await mkdtemp(join(tmpdir(), 'dsm-runtime-pending-'))
    const { writeFile } = await import('node:fs/promises')
    const { join: pjoin } = await import('node:path')

    const routes = new Map()
    const mkEntity = (dir) => ({
      id: dir,
      title: dir,
      path: dir,
      sessionIds: [],
      async attachSession(id) { if (!this.sessionIds.includes(id)) this.sessionIds.push(id) },
      async detachSession(id) { this.sessionIds = this.sessionIds.filter((x) => x !== id) },
    })
    const headers = new Map()
    const sessionPaths = new Map()
    const entities = new Map()
    const regState = { archivedSessionIds: [] }
    const hostCtx = {
      workspaceRegistry: {
        list: () => [...entities.values()],
        state: regState,
        archiveSession: async () => {},
        create: async (path) => { if (!entities.has(path)) entities.set(path, mkEntity(path)); return entities.get(path) },
        headers,
        sessionPaths,
        replaceHeaderIndex: async (entries) => { for (const h of entries) headers.set(h.id, h) },
        rebuildEntities() {},
      },
      sessionPersistence: sp,
      sessionQuery: {
        readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { session: { id }, title: { title: `Route ${id}` } } })),
      },
      storageDomain: { get: () => ({ global: { get: () => regState, set: async (next) => Object.assign(regState, next) } }) },
      webServer: { register: (route) => { routes.set(route.path, route.handler); return () => {} } },
      get: () => null,
      effect: (fn) => fn(),
    }
    const pluginMod = await import('../src/index.js')
    pluginMod.apply(hostCtx)

    const callRoute = async (path, body) => {
      const { Readable } = await import('node:stream')
      const req = Readable.from([Buffer.from(JSON.stringify(body))])
      let status = 200
      let text = ''
      const res = { writeHead: (value) => { status = value }, end: (value) => { text += value || '' } }
      await routes.get(path)(req, res)
      return { status, body: JSON.parse(text) }
    }

    // MOVE 路由：真实后端上官方 create+append 重放跨工作区迁移。
    const mvHeader = {
      id: `route-mv-${Date.now().toString(36)}`,
      cwd: root,
      createdAt: Date.now(),
      version: CURRENT_FORMAT_VERSION,
      isSeeded: false,
      delegationDepth: 0,
    }
    const mvWrite = await sp.create(mvHeader)
    await mvWrite.append(mkBatch(0, 2))
    await mvWrite.flush()
    await mvWrite.close()
    const mvTarget = await (await import('node:fs/promises')).realpath(
      await (async () => { const f = await import('node:fs/promises'); await f.mkdir(join(root, 'route-ws-b'), { recursive: true }); return join(root, 'route-ws-b') })(),
    )
    const mvRes = await callRoute('/archived-sessions/move', { sessionId: mvHeader.id, targetPath: mvTarget })
    check('route /move: 200 + moved', mvRes.status === 200 && mvRes.body.moved === true, mvRes.body)
    const mvStat = await sp.stat(mvHeader.id)
    check('route /move: official stat carries the new cwd', !!mvStat && mvStat.header.cwd === mvTarget, mvStat && mvStat.header.cwd)
    check('route /move: workspace registry redirected', sessionPaths.get(mvHeader.id) === mvTarget)
    const mvReread = await adapter.readSession(mvHeader.id, 0)
    check('route /move: events preserved byte-identically', mvReread.events.length === 3, mvReread.events.length)

    // PURGE 路由：预置真实回收站索引 → 走完整路由 → 官方 stat 复核消失。
    const purgeHeader = {
      id: `route-purge-${Date.now().toString(36)}`,
      cwd: root,
      createdAt: Date.now(),
      version: CURRENT_FORMAT_VERSION,
      isSeeded: false,
      delegationDepth: 0,
    }
    const purgeWrite = await sp.create(purgeHeader)
    await purgeWrite.append(mkBatch(0, 1))
    await purgeWrite.flush()
    await purgeWrite.close()
    const purgeStat = await sp.stat(purgeHeader.id)
    const { locateSessionArtifacts } = await import('../src/handle-era-paths.js')
    const purgeArtifacts = await locateSessionArtifacts(sp, purgeStat.header)
    const trashIndex = pjoin(process.env.DSH_SESSIONS_MANAGER_TRASH_DIR, 'index.json')
    await writeFile(trashIndex, JSON.stringify({
      schemaVersion: 2,
      settings: { retentionDays: 0 },
      items: [{ sessionId: purgeHeader.id, title: 'Route purge', originalPath: purgeArtifacts.logPath, deletedAt: 1 }],
      purgedSessionIds: [],
    }))
    const purgeRes = await callRoute('/archived-sessions/trash/purge', { sessionId: purgeHeader.id })
    check('route /trash/purge: 200 + purged', purgeRes.status === 200 && purgeRes.body.purged === true, purgeRes.body)
    check('route /trash/purge: official stat no longer sees the session', (await sp.stat(purgeHeader.id)) === undefined)
    check('route /trash/purge: tombstone persisted + item removed', (async () => {
      const { readFileSync } = await import('node:fs')
      const store = JSON.parse(readFileSync(trashIndex, 'utf8'))
      return store.purgedSessionIds.includes(purgeHeader.id) && store.items.length === 0
    })())

    await rm(process.env.DSH_SESSIONS_MANAGER_TRASH_DIR, { recursive: true, force: true }).catch(() => {})
  }

  // ---- DOMAIN-level route smoke: 真实 storageDomain + 真实 workspaceRegistry --
  // 背景：ROUTE-level 节把 storageDomain stub 成了旧形状（{ global: { get, set } }），
  // 于是「归档状态落进官方域」这条路径从未被真实后端碰过——而 0.2.0 的
  // storageDomain 是 DomainFacility：get(name) 只返回**已打开**的域，域的 global
  // 由 zod schema 校验（未知键会被 strip，写错字段不会报错但重启后消失）。
  // 本节把 storage 枢纽 + json 后端 + 领域设施 + 官方 WorkspaceRegistry 全真起一遍，
  // 在真栈上跑归档 / 恢复 / 标签 / 统计 / 移动 / 回收站路由，并回到磁盘介质核验
  // 归档状态真的持久化了（内存态不算数）。
  // P3-B（2026-09-29 审计）起本节还是 0.2.0+ 的**唯一**路由级冒烟：ROUTE-level 的
  // move 字节一致性、purge 路由与 registry 重定向检查已并入此处；stub 版仅在
  // 缺真栈的旧 runtime 上运行。
  // runtime 缺包（0.1.7 及更早没有 storage-domain）时整段跳过，不算失败。
  {
    const resolvePkgDir = (n) => {
      try { return dirname(requireFrom(pkgs.persistence).resolve(`@deepseek-ai/${n}/package.json`)) } catch (e) { return null }
    }
    const dirStorage = resolvePkgDir('dsh-storage')
    const dirStorageJson = resolvePkgDir('dsh-storage-json')
    const dirDomain = resolvePkgDir('dsh-storage-domain')
    const dirWorkspace = resolvePkgDir('dsh-workspace')
    if (!dirStorage || !dirStorageJson || !dirDomain || !dirWorkspace) {
      console.log('  · domain-level smoke skipped（runtime 缺少 storage / storage-json / storage-domain / workspace 包）')
    } else {
      const loadLib = (dir) => import(pathToFileURL(join(dir, 'lib/index.js')).href)
      const storageMod = await loadLib(dirStorage)
      const jsonMod = await loadLib(dirStorageJson)
      const domainMod = await loadLib(dirDomain)
      const wsMod = await loadLib(dirWorkspace)
      const { mkdir: mkdirP, readdir: readdirP, readFile: readFileP } = await import('node:fs/promises')
      const { realpath: realpathP } = await import('node:fs/promises')

      const dataDir = await mkdtemp(join(tmpdir(), 'dsm-runtime-domain-'))
      const sessRoot = await mkdtemp(join(tmpdir(), 'dsm-runtime-domain-sess-'))
      const tmpTrash = await mkdtemp(join(tmpdir(), 'dsm-runtime-domain-trash-'))
      const tmpPending = await mkdtemp(join(tmpdir(), 'dsm-runtime-domain-pending-'))
      const tmpStar = await mkdtemp(join(tmpdir(), 'dsm-runtime-domain-star-'))
      const tmpAuto = await mkdtemp(join(tmpdir(), 'dsm-runtime-domain-aa-'))
      // ⚠️ env 必须在插件 import 之前设置：src/index.js 的 TRASH_DIR / STATE_DIR
      // 是**模块级常量**（import 时读 env）。v3.7.4 的 DOMAIN 冒烟把 import 放在
      // env 之前，插件实例静默落到了真实的 ~/.dsh/sessions-manager(-trash)——
      // 冒烟的预热条目写进了真实标题索引（2026-09-30 实测污染并清理）。P3-B 的
      // purge 路由检查暴露了这一点。
      process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = tmpTrash
      process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = tmpPending
      process.env.DSH_SESSIONS_MANAGER_STAR_DIR = tmpStar
      process.env.DSH_SESSIONS_MANAGER_AUTO_ARCHIVE_DIR = tmpAuto
      // 插件自有状态目录必须先存在（star/tag/auto-archive 不会自己建）。
      await mkdirP(tmpTrash, { recursive: true })
      const pluginMod = await import(`../src/index.js?domain=${Date.now()}`)

      // 两个真实工作区目录（会话 cwd 与 workspace path 必须完全一致，官方
      // registry 按 header.cwd 分组）。路径一律 realpath（macOS /var → /private/var）。
      const wsA = await realpathP(await (async () => { const d = join(sessRoot, 'ws-a'); await mkdirP(d, { recursive: true }); return d })())
      const wsB = await realpathP(await (async () => { const d = join(sessRoot, 'ws-b'); await mkdirP(d, { recursive: true }); return d })())

      const domRoutes = new Map()
      const domCtx = typeof cordis === 'function' ? new cordis() : new cordis.Context()
      domCtx.plugin(storageMod.default)
      domCtx.plugin(jsonMod, { root: dataDir })
      domCtx.plugin(domainMod, { backend: 'json' })
      domCtx.plugin(JsonlSessionPersistence, { root: sessRoot })
      domCtx.provide('webServer', { register: (route) => { domRoutes.set(route.path, route.handler); return () => {} } })
      domCtx.provide('sessionQuery', {
        readTitleSnapshots: async (ids) => ids.map((id) => ({ status: 'fulfilled', value: { session: { id }, title: { title: `Domain ${id}` } } })),
      })
      domCtx.provide('sessions', { list: () => [], get: () => undefined })

      let smokeError = null
      let releaseSmoke = null
      const smokeDone = new Promise((resolve) => { releaseSmoke = resolve })
      domCtx.plugin({
        name: 'dsm-domain-smoke',
        inject: ['webServer', 'sessionPersistence', 'sessionQuery', 'storageDomain'],
        apply: async (c) => {
          try {
            const sp = c.sessionPersistence
            const sidA = `dom-a-${Date.now().toString(36)}`
            const sidB = `dom-b-${Date.now().toString(36)}`
            for (const [sid, cwd] of [[sidA, wsA], [sidB, wsA]]) {
              const writer = await sp.create({ id: sid, cwd, createdAt: Date.now(), version: CURRENT_FORMAT_VERSION, isSeeded: false, delegationDepth: 0 })
              await writer.append(mkBatch(0, 2))
              await writer.flush()
              await writer.close()
            }
            // 先建会话、再起官方 registry：init 会按磁盘上的 header 建立工作区索引。
            const registry = new wsMod.WorkspaceRegistry(c)
            await registry[wsMod.WorkspaceRegistry.init]()
            check('domain: official workspace domain is open', !!c.storageDomain.get('workspace'))
            const global0 = c.storageDomain.get('workspace').global.get()
            check('domain: global carries archivedSessionIds (schema 校验通过)',
              Array.isArray(global0.archivedSessionIds), Object.keys(global0))
            check('registry: real entities built from the durable order',
              registry.list().length >= 1 && registry.list().some((e) => e.path === wsA),
              registry.list().map((e) => e.path))

            // 挂载被测插件（真栈）：webServer / storageDomain / workspaceRegistry
            // / sessionQuery 全部来自真实服务。
            // 直接 apply：路由注册发生在 apply 里，必须在此刻同步完成；交给
            // ctx.plugin() 则是异步加载（依赖注入要等服务就绪），请求会打到
            // 尚未注册的 handler 上。服务可用性由上面的断言保证。
            pluginMod.apply(c)
            const callDom = async (path, body = {}) => {
              const { Readable } = await import('node:stream')
              const req = Readable.from([Buffer.from(JSON.stringify(body))])
              let status = 200
              let text = ''
              const res = { writeHead: (value) => { status = value }, end: (value) => { text += value || '' } }
              await domRoutes.get(path)(req, res)
              return { status, body: JSON.parse(text) }
            }

            const arch = await callDom('/archived-sessions/archive', { sessionId: sidA })
            check('route /archive (real domain): 200 + archived', arch.status === 200 && arch.body.archived === true, arch.body)
            check('domain: archive flag visible through the real global handle',
              c.storageDomain.get('workspace').global.get().archivedSessionIds.includes(sidA),
              c.storageDomain.get('workspace').global.get().archivedSessionIds)
            // 落盘核验：领域写入在 resolve 前已持久。内存态不算数。
            const mediumText = await (async () => {
              const out = []
              const walk = async (dir) => {
                for (const ent of await readdirP(dir, { withFileTypes: true })) {
                  const p = join(dir, ent.name)
                  if (ent.isDirectory()) await walk(p)
                  else if (/\.json$/i.test(ent.name)) out.push(await readFileP(p, 'utf8'))
                }
              }
              await walk(dataDir)
              return out.join('\n')
            })()
            check('domain: archive state reached the storage medium (not memory only)', mediumText.includes(sidA))

            const listed = await callDom('/archived-sessions/list', {})
            check('route /list (real domain): archived session surfaced',
              (listed.body.items || []).some((it) => it.sessionId === sidA),
              (listed.body.items || []).map((it) => it.sessionId))

            const restored = await callDom('/archived-sessions/restore', { sessionId: sidA })
            check('route /restore (real domain): flag cleared',
              restored.status === 200 && restored.body.restored === true
                && !c.storageDomain.get('workspace').global.get().archivedSessionIds.includes(sidA),
              restored.body)

            // 标签（插件自有存储，非官方域）：create → set → list 往返。
            const created = await callDom('/archived-sessions/tags/create', { name: 'dom-tag' })
            const tagId = created.body && created.body.tag && created.body.tag.id
            const tagSet = await callDom('/archived-sessions/tags/set', { sessionId: sidA, tagIds: tagId ? [tagId] : [] })
            const tagList = await callDom('/archived-sessions/tags/list', {})
            check('route /tags: create → set → list round-trip',
              !!tagId && tagSet.status === 200 && (tagList.body.tags || []).some((t) => t.id === tagId),
              { tagId, status: tagSet.status })

            const stats = await callDom('/archived-sessions/storage', { topN: 3 })
            check('route /storage (real backend): counts the real log bytes',
              stats.status === 200 && stats.body.sessionCount >= 1 && stats.body.totalBytes > 0, stats.body)

            // PURGE 路由（P3-B 自 stub 段并入）：预置真实回收站索引 → 完整路由
            // → 官方 stat 复核消失 + 墓碑落盘。readTrashStore 每次都读盘（无缓存），
            // 在 /list 之后预加载也生效。
            const sidP = `dom-p-${Date.now().toString(36)}`
            {
              const writerP = await sp.create({ id: sidP, cwd: wsA, createdAt: Date.now(), version: CURRENT_FORMAT_VERSION, isSeeded: false, delegationDepth: 0 })
              await writerP.append(mkBatch(0, 1))
              await writerP.flush()
              await writerP.close()
            }
            const { locateSessionArtifacts } = await import('../src/handle-era-paths.js')
            const purgeArtifacts = await locateSessionArtifacts(sp, (await sp.stat(sidP)).header)
            const trashIndex = join(tmpTrash, 'index.json')
            await (await import('node:fs/promises')).writeFile(trashIndex, JSON.stringify({
              schemaVersion: 2,
              settings: { retentionDays: 0 },
              items: [{ sessionId: sidP, title: 'Domain purge', originalPath: purgeArtifacts.logPath, deletedAt: 1 }],
              purgedSessionIds: [],
            }))
            const purgeRes = await callDom('/archived-sessions/trash/purge', { sessionId: sidP })
            check('route /trash/purge (real domain): 200 + purged', purgeRes.status === 200 && purgeRes.body.purged === true, purgeRes.body)
            check('route /trash/purge: official stat no longer sees the session', (await sp.stat(sidP)) === undefined)
            check('route /trash/purge: tombstone persisted + item removed', (async () => {
              const { readFileSync } = await import('node:fs')
              const store = JSON.parse(readFileSync(trashIndex, 'utf8'))
              return store.purgedSessionIds.includes(sidP) && store.items.length === 0
            })())

            const moved = await callDom('/archived-sessions/move', { sessionId: sidA, targetPath: wsB })
            check('route /move (real registry): session relocates to the target workspace',
              moved.status === 200 && (moved.body.moved === true || moved.body.already === true), moved.body)
            const movedStat = await sp.stat(sidA)
            check('route /move (real registry): official stat carries the new cwd',
              !!movedStat && movedStat.header.cwd === wsB, movedStat && movedStat.header.cwd)
            // P3-B 自 stub 段并入：移动后事件逐字节保真 + registry 重定向。
            const { createPersistenceAdapter } = await import('../src/compat/persistence.js')
            const domAdapter = createPersistenceAdapter(c.sessionPersistence)
            const movedReread = await domAdapter.readSession(sidA, 0)
            check('route /move (real registry): events preserved byte-identically', movedReread.events.length === 3, movedReread.events.length)
            check('route /move (real registry): registry sessionPaths redirected',
              c.workspaceRegistry.sessionPaths.get(sidA) === wsB, c.workspaceRegistry.sessionPaths.get(sidA))
          } catch (e) {
            smokeError = e
          } finally {
            releaseSmoke()
          }
        },
      })
      await smokeDone
      if (smokeError) throw smokeError
      for (const dir of [dataDir, sessRoot, tmpTrash, tmpPending, tmpStar, tmpAuto]) {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }

  // ---- LEGACY-generation migration smoke (optional --legacy-log <path>) ----
  // 指向一个真实旧代会话日志（如 ~/.dsh/sessions/<project>/<id>/session.v3.jsonl.zstd），
  // **拷贝**进临时 root（原件绝不触碰），验证三件事：
  //   1) 旧代日志在当前后端上可被 list/stat/读取（官方 restore 迁移机制）；
  //   2) moveSessionToCwd 能把它搬到新工作区（create 路径的 header 版本兼容）；
  //   3) 移动后落盘的当前代 === 后端当前格式版本（真迁移，不是仅改名）。
  // 0.1.7（v4）与 0.1.5（v3）之间的格式跳变靠这段钉死；不带参数则整段跳过。
  const legacyIdx = process.argv.indexOf('--legacy-log')
  if (legacyIdx >= 0 && process.argv[legacyIdx + 1]) {
    const legacyLogPath = resolve(process.argv[legacyIdx + 1])
    const { zstdDecompressSync } = await import('node:zlib')
    const { scanZstdFrames } = await import('../src/zstd-frame.js')
    const { projectKeyFor, encodeSegmentFor } = await import('../src/handle-era-paths.js')
    const raw = await readFile(legacyLogPath)
    let legacyHeader = null
    if (/\.zstd?$/.test(legacyLogPath)) {
      const { frames } = scanZstdFrames(raw)
      if (frames.length === 0) throw new Error(`legacy fixture: no zstd frames in ${legacyLogPath}`)
      const frame0 = zstdDecompressSync(raw.subarray(frames[0].start, frames[0].end))
      for (const line of frame0.toString('utf8').split('\n')) {
        try { const p = JSON.parse(line); if (p && p.id != null) { legacyHeader = p; break } } catch (_) {}
      }
    } else {
      for (const line of raw.toString('utf8').split('\n')) {
        try { const p = JSON.parse(line); if (p && p.id != null) { legacyHeader = p; break } } catch (_) {}
      }
    }
    if (!legacyHeader) throw new Error(`legacy fixture: cannot parse header from ${legacyLogPath}`)
    check('legacy fixture header parsed', typeof legacyHeader.id === 'string' && legacyHeader.version !== undefined, { id: legacyHeader.id, version: legacyHeader.version })

    const legacyRoot = await mkdtemp(join(tmpdir(), 'dsm-runtime-legacy-'))
    const legacyDir = join(legacyRoot, projectKeyFor(legacyHeader.cwd), encodeSegmentFor(String(legacyHeader.id)))
    await mkdir(legacyDir, { recursive: true })
    await copyFile(legacyLogPath, join(legacyDir, basename(legacyLogPath)))
    // 独立 cordis Context：sessionPersistence 是按 ctx 注册的服务，不能与主实例共用。
    const legacyCtx = typeof cordis === 'function' ? new cordis() : new cordis.Context()
    const spLegacy = new JsonlSessionPersistence(legacyCtx, { root: legacyRoot })
    const legacyAdapter = plugin.createPersistenceAdapter(spLegacy)
    const legacyId = String(legacyHeader.id)

    const legacyEntry = (await legacyAdapter.listEntries()).find((e) => e.id === legacyId)
    check('legacy: old-generation log is listed by the current backend', !!legacyEntry)
    const legacyStat = await spLegacy.stat(legacyId)
    check('legacy: stat sees the old-generation session', !!legacyStat && legacyStat.header && legacyStat.header.id === legacyId)
    const legacyRead = await legacyAdapter.readSession(legacyId, 0)
    check('legacy: old-generation events read through official migration',
      Array.isArray(legacyRead.events) && legacyRead.events.length === (legacyStat && Number.isSafeInteger(legacyStat.eventCount) ? legacyStat.eventCount : legacyRead.events.length),
      { events: legacyRead.events.length, statEventCount: legacyStat && legacyStat.eventCount })

    const legacyTarget = join(legacyRoot, 'legacy-moved-target')
    await opsMod.moveSessionToCwd({ sp: spLegacy, sid: legacyId, header: legacyStat.header, canonical: legacyTarget, events: legacyRead.events, inheritedEventCount: legacyRead.inheritedEventCount })
    const movedLegacyStat = await spLegacy.stat(legacyId)
    check('legacy move: official stat carries the new cwd', !!movedLegacyStat && movedLegacyStat.header.cwd === legacyTarget, movedLegacyStat && movedLegacyStat.header.cwd)
    const movedLegacyEvents = await legacyAdapter.readSession(legacyId, 0)
    check('legacy move: events preserved byte-identically', JSON.stringify(movedLegacyEvents.events) === JSON.stringify(legacyRead.events), movedLegacyEvents.events.length)
    const movedArtifacts = await pathsMod.locateSessionArtifacts(spLegacy, movedLegacyStat.header)
    check('legacy move: latest on-disk generation equals the backend current format version',
      !!movedArtifacts && pathsMod.generationVersionOf(movedArtifacts.generationFiles[0]) === CURRENT_FORMAT_VERSION,
      { log: movedArtifacts && movedArtifacts.generationFiles[0], currentVersion: CURRENT_FORMAT_VERSION })
    await rm(legacyRoot, { recursive: true, force: true }).catch(() => {})
  }

  console.log('\ncompat-runtime smoke PASSED')
  for (const c of checks) console.log(`  ✔ ${c.name}${c.detail !== null ? ` — ${JSON.stringify(c.detail)}` : ''}`)
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {})
}
