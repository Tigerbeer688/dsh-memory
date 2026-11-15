/**
 * cross-session-query.test.ts · 【灵枢交易教训】的查询词必须按会话隔离（C6）
 *
 * 守什么（2026-11-15 20:39 实测事故的直接回归）：
 *   一个宿主进程同时服务多个工作区/会话。原实现用**实例级** `let lastUserMsg`
 *   缓存「最近一条真实用户输入」，后一条覆盖前一条。事故形态：
 *     · 本会话（工程域）最后一条用户消息是「已经重启」
 *     · 同进程另一个工作区会话发出「market-review 系统性复盘」
 *     → 本会话的 knowledge 查询词变成交易语料 → queryIsMarket=true
 *     → C1 跨域配额整条失效（5 槽位全被交易语料填满，实测分数 0.82/0.78/0.55×3）
 *   即 C1 的修复被另一条会话从侧门绕过。缓存键必须与 routeSeed/knowledgePin 同构。
 *
 * 断言口径：**查询词本身**（read 收到的第一个参数）按会话取，块内容随之分流。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMemoryHooks } from '../src/hooks.ts'

interface Assembly {
  contexts: Array<{ name: string; text: string }>
  variables: Record<string, string>
}

type Item = { id: string; score: number; content: string; tags: string[] }

function makeHarness(items: Item[]): {
  listeners: Map<string, (a?: unknown, b?: unknown, c?: unknown) => Promise<unknown>>
  queries: string[]
} {
  const listeners = new Map<string, (a?: unknown, b?: unknown, c?: unknown) => Promise<unknown>>()
  const queries: string[] = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: never) { listeners.set(ev, fn as never) },
  } as never
  const client = {
    isReady: () => true,
    async timeline() { return { count: 0, limit: 4, items: [] as unknown[] } },
    async remember() { return { ok: true } },
    async read(query: string) {
      queries.push(query)
      const results = items.map((it) => ({
        node: { id: `${it.id}.md`, content: it.content, frontmatter: { id: it.id, tags: it.tags, access_count: 0 } },
        score: it.score,
        state: 'ACCEPT',
      }))
      return { results }
    },
    async recall() { return { ok: true } },
    async route() { throw new Error('route 不参与本测试') },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
  })
  return { listeners, queries }
}

function engItem(n: number, score: number): Item {
  return {
    id: `mem_crosseng000${n}`, score, tags: ['dsh', 'plugin'],
    content: `# 功能名 工程教训 ${n}\n构建产物与源码不一致时，先核对符号链接目标再谈重装。`,
  }
}

function tradeItem(n: number, score: number): Item {
  return {
    id: `mem_crosstrade00${n}`, score, tags: ['correction', '已确认教训'],
    content: `# 功能名 收盘轮定稿 ${n}\n本轮闸门全部通过，只做记录，不建仓。`,
  }
}

const ITEMS: Item[] = [
  engItem(1, 0.30), engItem(2, 0.28),
  tradeItem(1, 0.26), tradeItem(2, 0.24), tradeItem(3, 0.22), tradeItem(4, 0.20),
]

async function feed(
  listeners: Map<string, (a?: unknown, b?: unknown, c?: unknown) => Promise<unknown>>,
  sessionId: string, text: string,
): Promise<void> {
  const onSession = listeners.get('session/event')
  assert.ok(onSession, '应注册 session/event 监听')
  await onSession({ id: sessionId }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }, async () => undefined)
}

async function assemble(
  listeners: Map<string, (a?: unknown, b?: unknown, c?: unknown) => Promise<unknown>>,
  sessionId: string,
): Promise<string> {
  const onAssemble = listeners.get('system-prompt/assemble')
  assert.ok(onAssemble, '应注册 system-prompt/assemble 监听')
  const assembly: Assembly = { contexts: [], variables: {} }
  await onAssemble(assembly, { agent: { session: { id: sessionId } } }, async () => assembly)
  const block = assembly.contexts.find((c) => c.name === 'lingshu:knowledge-recall')
  return block ? block.text : ''
}

test('C6 另一会话的交易消息不得污染本会话的查询词与注入块', async () => {
  const h = makeHarness(ITEMS)
  await feed(h.listeners, 's-a', '插件加载失败怎么办')
  // 同进程里的另一个工作区会话（交易域）发出「复盘」类消息——曾把单值缓存覆盖掉
  await feed(h.listeners, 's-b', 'market-review 系统性复盘')

  const blockA = await assemble(h.listeners, 's-a')
  const qA = h.queries[h.queries.length - 1]
  assert.ok(qA.startsWith('插件加载失败怎么办'), `A 的查询词必须取 A 自己的消息，实测：${qA.slice(0, 40)}`)
  assert.ok(!qA.includes('复盘'), 'A 的查询词不得混入 B 的交易语料')
  const tradeLinesA = (blockA.match(/收盘轮定稿/g) || []).length
  assert.equal(tradeLinesA, 1, 'A 是工程域 → 跨域配额仍生效（≤1 条安全阀）')
  assert.ok(blockA.includes('工程教训'), 'A 的块应有同域条目')

  // 反向：B 自己装配时，查询词取 B 的消息（交易域 → 条目不降权）
  const blockB = await assemble(h.listeners, 's-b')
  const qB = h.queries[h.queries.length - 1]
  assert.ok(qB.startsWith('market-review'), `B 的查询词必须取 B 自己的消息，实测：${qB.slice(0, 40)}`)
  const tradeLinesB = (blockB.match(/收盘轮定稿/g) || []).length
  assert.ok(tradeLinesB >= 3, `B 是交易域 → 交易条目不再降权（实测 ${tradeLinesB} 条）`)
})

test('C6 会话键隔离：A 的定版不会被 B 的装配改写', async () => {
  const h = makeHarness(ITEMS)
  await feed(h.listeners, 's-a', '插件加载失败怎么办')
  await feed(h.listeners, 's-b', 'market-review 系统性复盘')
  const a1 = await assemble(h.listeners, 's-a')
  await assemble(h.listeners, 's-b')   // B 装配一次（会各自定版）
  const a2 = await assemble(h.listeners, 's-a')
  assert.equal(a2, a1, 'A 的块必须逐字节不变（定版按会话键隔离）')
})

test('C6 无会话标识的装配不得借用任何会话的缓存', async () => {
  const h = makeHarness(ITEMS)
  await feed(h.listeners, 's-a', '插件加载失败怎么办')
  // 无 ctx.agent.session → rKey='__global__' → 没有该键的缓存 → 不发起 knowledge 查询
  const before = h.queries.length
  const block = await assemble(h.listeners, '')
  assert.equal(h.queries.length, before, '无会话缓存时不得用别的会话的消息发查询')
  assert.equal(block, '', '无查询 → 无块（而不是拿别人的块）')
})