// 活跃会话（host 侧）追踪。
//
// 背景：0.1.7 / 0.2.0 把「当前选中哪个会话」这件事完全放到了客户端——
// uiWorkspace 持有 mainView 的会话引用，host 进程里根本不存在
// activeSession / currentSession / sessions.active 任何一个访问器（实测三个
// 探测全部落空）。而 host 又必须知道「这个会话是不是用户正在看的那个」：
//   - 移动：活跃会话被写锁持有，动盘要排到 DSH 释放之后（409 / 排队）
//   - 自动归档：正在看的会话不该被默默归档掉
// host 自己证明不了，只能由能看到 UI 状态的客户端心跳上报。
//
// 设计取舍：
//   * 按 clientId 分桶——浏览器端与 Desktop 端可能同时连着同一个 host，各自看
//     的会话不同，只留一份会互相顶掉。
//   * 只采信「新鲜」的心跳（TTL）。客户端面板关闭 / 标签页隐藏 / 进程退出后
//     心跳停止，过期数据必须失效：宁可漏判（放行移动，移动路径本身有备份+
//     回滚和写锁兜底），也不拿陈旧数据把用户早已切走的会话一直锁死。
//   * 上报 null/空 = 该客户端当前没有活跃会话，删掉它的桶（而不是留旧值）。

export const DEFAULT_ACTIVE_TTL_MS = 45 * 1000
// 桶数量上限：clientId 由客户端生成，理论无限。超过就先清过期的，再清最旧的，
// 防止异常客户端（每次刷新换 id）把 Map 撑大。
export const MAX_ACTIVE_REPORTS = 32

// 与 host 侧会话 id 校验同源（src/index.js isSafeSessionId）：会话 id 会参与
// 日志路径拼接，含路径分隔符的脏数据必须挡在外面。
function isUsableSessionId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !/[\\/\0]/.test(value)
    && value !== '.'
    && value !== '..'
}

export function createActiveSessionTracker(options = {}) {
  const ttl = Number.isFinite(options.ttlMs) ? Number(options.ttlMs) : DEFAULT_ACTIVE_TTL_MS
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  /** @type {Map<string, {id: string, at: number}>} */
  const reports = new Map()

  function trim(at) {
    for (const [key, value] of reports) if (at - value.at > ttl) reports.delete(key)
    while (reports.size > MAX_ACTIVE_REPORTS) {
      const oldest = reports.keys().next().value
      if (oldest === undefined) break
      reports.delete(oldest)
    }
  }

  /**
   * Record one client's currently-open session.
   * @param {string} clientId
   * @param {string|null} sessionId - null clears this client's slot.
   * @returns {boolean} whether it was accepted.
   */
  function report(clientId, sessionId, at = now()) {
    const key = typeof clientId === 'string' && clientId ? clientId.slice(0, 64) : 'default'
    if (sessionId === null || sessionId === undefined || sessionId === '') {
      reports.delete(key)
      return true
    }
    if (!isUsableSessionId(sessionId)) return false
    reports.set(key, { id: String(sessionId), at })
    trim(at)
    return true
  }

  /**
   * Freshly reported active session ids (any connected client).
   * @returns {Set<string>}
   */
  function activeIds(at = now()) {
    const out = new Set()
    for (const [key, value] of reports) {
      if (at - value.at > ttl) { reports.delete(key); continue }
      out.add(value.id)
    }
    return out
  }

  return {
    report,
    activeIds,
    get size() { return reports.size },
    clear() { reports.clear() },
  }
}
