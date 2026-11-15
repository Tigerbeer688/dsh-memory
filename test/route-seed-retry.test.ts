/**
 * route-seed-retry.test.ts · 「路由起手」块的失败重试（C5）生产路径守卫
 *
 * 守什么（2026-11-15 实测事故）：
 *   原实现把 **route 失败** 也写进按会话缓存（`routeSeed.set(rKey, '')`），缓存命中
 *   判据是 `has()` → 失败一次即「本会话永久不再重试」，且与「成功但无能力命中」在
 *   缓存里是同一个值 `''`，事后无法区分。
 *   实测时间线（2026-11-15 第二次启动，PID 1992 @ 13:09:46）：13:10:20 / 13:10:32 /
 *   13:10:41 三次注入均无该块，直到 13:05 那次才会出现——即 md_cg 桥懒加载（395 个
 *   模块）完成后才可 route，延迟可达数分钟。
 *
 * 因此契约是**只节流、不放弃**：
 *   · 失败不写成功缓存 → 以后还能重试；
 *   · 两次尝试至少间隔 ROUTE_RETRY_MS=20s（坏掉时不每步撞墙）；
 *   · **无次数上限**——首版实现用「最多 3 次」，会在桥就绪前用尽配额，等于把同一个
 *     bug 换个写法保留（3 次 assemble 只覆盖头几秒，而桥要几分钟才就绪）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMemoryHooks } from '../src/hooks.ts'

interface Assembly {
  contexts: Array<{ name: string; text: string }>
  variables: Record<string, string>
}

interface Harness {
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>
  routeCalls: () => number
}

/** 可控时钟：hooks 在调用时读 Date.now，测试里直接偏移即可。 */
function installClock(): { tick: (ms: number) => void; restore: () => void } {
  const real = Date.now
  let offset = 0
  Date.now = () => real() + offset
  return {
    tick: (ms: number) => { offset += ms },
    restore: () => { Date.now = real },
  }
}

function makeHarness(routeImpl: () => Promise<unknown>): Harness {
  const listeners = new Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>()
  let calls = 0
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: never) { listeners.set(ev, fn as never) },
  } as never
  const client = {
    isReady: () => true,
    async timeline() { return { count: 0, limit: 4, items: [] as unknown[] } },
    async remember() { return { ok: true } },
    async read() { return { results: [] } },
    async recall() { return { ok: true } },
    async route(_q: string) { calls += 1; return routeImpl() },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
  })
  return { listeners, routeCalls: () => calls }
}

async function feedUser(listeners: Harness['listeners'], text: string): Promise<void> {
  const onSession = listeners.get('session/event')
  assert.ok(onSession, '应注册 session/event 监听')
  await onSession({ id: 's-route-1' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  } as never, async () => undefined as never)
}

async function assemble(listeners: Harness['listeners']): Promise<Assembly> {
  const onAssemble = listeners.get('system-prompt/assemble')
  assert.ok(onAssemble, '应注册 system-prompt/assemble 监听')
  const assembly: Assembly = { contexts: [], variables: {} }
  await onAssemble(assembly, { agent: { session: { id: 's-route-1' } } } as never,
    async () => assembly)
  return assembly
}

const routeBlock = (a: Assembly): { name: string; text: string } | undefined =>
  a.contexts.find((c) => c.name === 'lingshu:route-seed')

test('失败不写入缓存 + 20s 节流：三次失败后第 4 次成功即注入', async () => {
  const clock = installClock()
  try {
    let n = 0
    const h = makeHarness(async () => {
      n += 1
      if (n <= 3) throw new Error('md_cg 尚未就绪')
      return { suggested_capabilities: ['verify', 'remember'] }
    })
    await feedUser(h.listeners, '插件加载失败怎么办')

    for (let i = 1; i <= 3; i += 1) {
      const a = await assemble(h.listeners)
      assert.equal(h.routeCalls(), i, `第 ${i} 次尝试应发生（失败不缓存）`)
      assert.equal(routeBlock(a), undefined, `第 ${i} 次失败 → 本轮不注入`)
      clock.tick(25_000)   // 越过 20s 节流窗
    }

    const fourth = routeBlock(await assemble(h.listeners))
    assert.ok(fourth, '桥就绪后必须补上该块（原实现在此永久无块）')
    assert.ok(fourth!.text.includes('建议能力：verify、remember'), '能力列表应写入块正文')
    assert.ok(fourth!.text.includes('lingshu:fmt=2'), '路由起手块同样带形态版本戳')
    assert.equal(h.routeCalls(), 4, '失败 3 次 + 成功 1 次 = 4 次调用')

    const again = await assemble(h.listeners)
    assert.equal(h.routeCalls(), 4, '成功结果应缓存，后续不再调用 route')
    assert.equal(routeBlock(again)!.text, fourth!.text, '成功块每步原样重推（稳定性契约）')
  } finally {
    clock.restore()
  }
})

test('节流：同一时刻连续 assemble 不得每步撞墙', async () => {
  const clock = installClock()
  try {
    const h = makeHarness(async () => { throw new Error('bridge down') })
    await feedUser(h.listeners, '插件加载失败怎么办')
    await assemble(h.listeners)
    await assemble(h.listeners)
    await assemble(h.listeners)
    assert.equal(h.routeCalls(), 1, '20s 节流窗内只允许 1 次调用')
  } finally {
    clock.restore()
  }
})

test('不放弃：持续失败 10 次（每次越过节流窗）仍会重试，且不抛错', async () => {
  const clock = installClock()
  try {
    const h = makeHarness(async () => { throw new Error('bridge down') })
    await feedUser(h.listeners, '插件加载失败怎么办')
    for (let i = 1; i <= 10; i += 1) {
      const a = await assemble(h.listeners)
      assert.equal(h.routeCalls(), i, `第 ${i} 轮仍应重试（无次数上限）`)
      assert.equal(routeBlock(a), undefined, '失败不注入块')
      clock.tick(25_000)
    }
    assert.equal(h.routeCalls(), 10, '不得出现「放弃」状态')
  } finally {
    clock.restore()
  }
})

test('对照：route 成功但无能力命中 → 空串缓存，本会话不再重试', async () => {
  const clock = installClock()
  try {
    const h = makeHarness(async () => ({ suggested_capabilities: [] }))
    await feedUser(h.listeners, '插件加载失败怎么办')
    assert.equal(routeBlock(await assemble(h.listeners)), undefined, '无能力命中 → 不注入')
    clock.tick(60_000)
    await assemble(h.listeners)
    assert.equal(h.routeCalls(), 1, '空结果也是成功，缓存后不再调用（防每步撞墙）')
  } finally {
    clock.restore()
  }
})