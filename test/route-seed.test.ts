/**
 * route-seed.test.ts · route 起手兑底（评估优化②）的行为守卫
 *
 * 守什么（纪律 0.1「先 route 再干活」实测 47 次会话仅 2 次显式调用）：
 *   1. 会话首条 lastUserMsg 触发一次 cg(op=route)，建议能力注入
 *      lingshu:route-seed 块（agent 不调 route 也拿得到）。
 *   2. 同会话第二步：不再发第二次 route（按会话缓存），块每步原样重推
 *      且逐字节相同（稳定性契约：内容不变 → 宿主零追加）。
 *   3. route 返回空能力 → 不注入块；失败 → 不注入块且本会话不再重试。
 *
 * 走的是真生产路径：installMemoryHooks 的 session/event → system-prompt/assemble。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMemoryHooks } from '../src/hooks.ts'

interface Assembly {
  contexts: Array<{ name: string; text: string }>
  variables: Record<string, string>
}

function makeHarness(routeImpl: () => Promise<unknown>): {
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>
  routeCalls: number
} {
  const listeners = new Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>()
  const state = { routeCalls: 0 }
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
    async route() { state.routeCalls += 1; return routeImpl() },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
  })
  return {
    listeners,
    get routeCalls() { return state.routeCalls },
  }
}

async function feedUserMessage(
  listeners: Map<string, unknown>, text: string): Promise<void> {
  const onSession = listeners.get('session/event') as
    (s: unknown, e: unknown, n: () => Promise<unknown>) => Promise<unknown>
  await onSession({ id: 's-route-1' }, {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text }],
    },
  } as never, async () => undefined as never)
}

async function assemble(
  listeners: Map<string, unknown>): Promise<Assembly> {
  const onAssemble = listeners.get('system-prompt/assemble') as
    (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>
  const assembly: Assembly = { contexts: [{ name: 'clock', text: '当前时间 12:00' }], variables: {} }
  await onAssemble(assembly, { agent: { session: { id: 's-route-1' } } } as never,
    async () => assembly)
  return assembly
}

test('① 会话首条用户消息自动 route 一次，建议能力注入 route-seed 块', async () => {
  const h = makeHarness(async () => ({
    knowledge: [],
    suggested_capabilities: ['swing-trading', 'risk-control'],
  }))
  await feedUserMessage(h.listeners, '帮我看看中际旭创要不要止损')
  const a = await assemble(h.listeners)

  assert.equal(h.routeCalls, 1, '应发起一次 cg(op=route)')
  const block = a.contexts.find((c) => c.name === 'lingshu:route-seed')
  assert.ok(block, '应注入 lingshu:route-seed 块')
  assert.ok(block!.text.includes('swing-trading'), '能力名应注入')
  assert.ok(block!.text.includes('risk-control'), '能力名应注入')
  assert.ok(block!.text.includes('灵枢路由起手'), '固定标题')
})

test('② 同会话第二步：不再 route，块每步原样重推且逐字节相同', async () => {
  const h = makeHarness(async () => ({
    knowledge: [],
    suggested_capabilities: ['swing-trading'],
  }))
  await feedUserMessage(h.listeners, '帮我看看要不要止损')
  const first = await assemble(h.listeners)
  const second = await assemble(h.listeners)

  assert.equal(h.routeCalls, 1, '第二步不得再发 route（按会话缓存）')
  const b1 = first.contexts.find((c) => c.name === 'lingshu:route-seed')
  const b2 = second.contexts.find((c) => c.name === 'lingshu:route-seed')
  assert.ok(b1 && b2, '第二步仍须重推（不许跳过 push）')
  assert.equal(b1!.text, b2!.text, '同会话连续两步须逐字节相同 → 宿主不追加新快照')
})

test('③ route 返回空能力：不注入块', async () => {
  const h = makeHarness(async () => ({ knowledge: [], suggested_capabilities: [] }))
  await feedUserMessage(h.listeners, '随便聊聊天气')
  const a = await assemble(h.listeners)
  assert.equal(h.routeCalls, 1, '仍应尝试一次')
  assert.ok(!a.contexts.some((c) => c.name === 'lingshu:route-seed'),
    '无能力命中不注入空块')
})

test('④ route 失败：不注入块，且本会话不再重试', async () => {
  const h = makeHarness(async () => { throw new Error('MCP down') })
  await feedUserMessage(h.listeners, '帮我看看要不要止损')
  const first = await assemble(h.listeners)
  assert.equal(h.routeCalls, 1, '首次尝试一次')
  assert.ok(!first.contexts.some((c) => c.name === 'lingshu:route-seed'),
    '失败不注入块')

  const second = await assemble(h.listeners)
  assert.equal(h.routeCalls, 1, '失败后本会话不得重试（防每步撞墙）')
  assert.ok(!second.contexts.some((c) => c.name === 'lingshu:route-seed'))
})

test('⑤ 无 lastUserMsg（纯组装步）：不触发 route', async () => {
  const h = makeHarness(async () => ({
    knowledge: [],
    suggested_capabilities: ['swing-trading'],
  }))
  const a = await assemble(h.listeners)
  assert.equal(h.routeCalls, 0, '无用户消息不 route')
  assert.ok(!a.contexts.some((c) => c.name === 'lingshu:route-seed'))
})
