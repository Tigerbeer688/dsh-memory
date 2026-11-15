/**
 * knowledge-stability.test.ts · 【灵枢交易教训】块的选择稳定化（C2）与断言化（C3）
 *
 * 守什么（2026-11-15 审计的直接回归）：
 *   C2 —— 相邻两步注入块变化率 36%（1,299 对相邻步），而「分数抖动」只能解释 1.9%
 *        （1,274/1,299 对标题集合相同的相邻步，分数逐条相同）。真因是每步重算选择集：
 *        recentInjected 窗口一推就换一批 → 宿主每步都判定「文本变了」→ 追加快照。
 *        修法：按会话定版（pin），连续 PIN_ROTATE_STEPS=12 步逐字节重推；只在
 *        ①无定版 ②域类翻转 ③轮换期到 ④定版节点消失 时重选。
 *   C3 —— 本块原先没有长度上限（timeline 块有 1400），实测均值 3.6 KB、最长 8 KB+，
 *        大量内容是「## 事实（…）```python…```」过程叙述。改为清单化：单条 ≤120 字符
 *        单行、整块 ≤1200 字符。
 *
 * 走真生产路径：installMemoryHooks 的 session/event → system-prompt/assemble。
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
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>
  setItems: (next: Item[]) => void
  readCalls: () => number
} {
  const listeners = new Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>()
  let current = items
  let calls = 0
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: never) { listeners.set(ev, fn as never) },
  } as never
  const client = {
    isReady: () => true,
    async timeline() { return { count: 0, limit: 4, items: [] as unknown[] } },
    async remember() { return { ok: true } },
    async read() {
      calls += 1
      // 模拟真实 read 面的抖动：分数微扰 + 顺序打乱（这是实测到的 1.9% 抖动的来源）
      const jitter = current.map((it, i) => ({
        node: {
          id: `${it.id}.md`,
          content: it.content,
          frontmatter: { id: it.id, tags: it.tags, access_count: 0 },
        },
        score: Math.max(0.05, it.score + ((calls + i) % 3) * 0.01),
        state: 'DEFER',
      }))
      jitter.reverse()
      return { results: jitter }
    },
    async recall() { return { ok: true } },
    async route() { throw new Error('route 不参与本测试') },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
  })
  return { listeners, setItems: (next: Item[]) => { current = next }, readCalls: () => calls }
}

/** 工程域条目：正文不得命中 MARKET_DOMAIN_RE 的任何词。 */
function engItem(n: number, score: number, extra = ''): Item {
  return {
    id: `mem_engbuild00000${n}`,
    score,
    tags: ['dsh', 'plugin'],
    content: `# 功能名 工程教训 ${n}\n构建产物与源码不一致时，先核对符号链接目标再谈重装。${extra}`,
  }
}

/** 交易域条目：只用交易语料常见说法（C1.5 扩展后的词表才认）。 */
function tradeItem(n: number, score: number): Item {
  return {
    id: `mem_tradeclose000${n}`,
    score,
    tags: ['correction', '已确认教训'],
    content: `# 功能名 收盘轮定稿 ${n}\n本轮闸门全部通过，只做记录，不建仓。`,
  }
}

async function feedUser(
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>,
  text: string,
): Promise<void> {
  const onSession = listeners.get('session/event')
  assert.ok(onSession, '应注册 session/event 监听')
  await onSession({ id: 's-stab-1' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  } as never, async () => undefined as never)
}

async function assemble(
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>,
): Promise<string> {
  const onAssemble = listeners.get('system-prompt/assemble')
  assert.ok(onAssemble, '应注册 system-prompt/assemble 监听')
  const assembly: Assembly = { contexts: [], variables: {} }
  // C6：必须带显式会话（同 production 的 ctx.agent.session），否则不注入知识块
  await onAssemble(assembly, { agent: { session: { id: 's-stab-1' } } } as never,
    async () => assembly)
  const block = assembly.contexts.find((c) => c.name === 'lingshu:knowledge-recall')
  return block ? block.text : ''
}

test('C2 稳定性：连续 12 步（分数抖动+顺序打乱）块文本逐字节不变', async () => {
  const h = makeHarness([
    engItem(1, 0.30), engItem(2, 0.28), engItem(3, 0.26), engItem(4, 0.24), engItem(5, 0.22),
  ])
  await feedUser(h.listeners, '插件加载失败怎么办')
  const first = await assemble(h.listeners)
  assert.ok(first.includes('工程教训 1'), '首步应注入同域条目')
  for (let i = 2; i <= 12; i += 1) {
    assert.equal(await assemble(h.listeners), first, `第 ${i} 步必须与首步逐字节相同`)
  }
})

test('C2 轮换：第 13 步（越过 PIN_ROTATE_STEPS=12）换一批', async () => {
  const items = [
    engItem(1, 0.30), engItem(2, 0.28), engItem(3, 0.26), engItem(4, 0.24),
    engItem(5, 0.22), engItem(6, 0.20), engItem(7, 0.18), engItem(8, 0.16),
  ]
  const h = makeHarness(items)
  await feedUser(h.listeners, '插件加载失败怎么办')
  const texts: string[] = []
  for (let i = 1; i <= 13; i += 1) texts.push(await assemble(h.listeners))
  assert.equal(texts[11], texts[0], '轮换期内（1~12 步）保持不变')
  assert.notEqual(texts[12], texts[0], '第 13 步必须轮换出新一批（长尾可见）')
  assert.ok(texts[12].includes('工程教训'), '轮换后仍是同域条目')
})

test('C2 失效①：定版节点从候选中消失 → 立即重选，不等轮换期', async () => {
  const base = [engItem(1, 0.30), engItem(2, 0.28), engItem(3, 0.26)]
  const h = makeHarness(base)
  await feedUser(h.listeners, '插件加载失败怎么办')
  const first = await assemble(h.listeners)
  assert.ok(first.includes('工程教训 1'))
  h.setItems([engItem(9, 0.30), engItem(2, 0.28), engItem(3, 0.26)])   // 1 号消失
  const second = await assemble(h.listeners)
  assert.notEqual(second, first, '定版失效必须立刻重选（否则块里会留着已删节点）')
  assert.ok(second.includes('工程教训 9'), '重选应补入新候选')
  assert.ok(!second.includes('工程教训 1'), '消失的节点不得残留')
})

test('C2 失效②：域类翻转（工程 → 交易）→ 立即重选', async () => {
  const h = makeHarness([
    engItem(1, 0.30), engItem(2, 0.28),
    tradeItem(1, 0.20), tradeItem(2, 0.18),
  ])
  await feedUser(h.listeners, '插件加载失败怎么办')
  const eng = await assemble(h.listeners)
  const tradeLines = (t: string): number => (t.match(/收盘轮定稿/g) || []).length
  assert.equal(tradeLines(eng), 1, '工程查询下跨域受 C1 配额约束（最多 1 条安全阀）')
  await feedUser(h.listeners, '追高买入后仓位怎么设')
  const trade = await assemble(h.listeners)
  assert.notEqual(trade, eng, '域类翻转必须重选')
  assert.equal(tradeLines(trade), 2, '交易查询时交易条目不降权 → 2 条都进')
  assert.ok(trade.includes('收盘轮'), '交易查询时交易条目不再降权')
})

test('C3 断言化：单条 ≤120 字符单行、整块 ≤1200 字符、超长条目截断加省略号', async () => {
  const long = '程序化生成的验收说明：'.repeat(20)
  const items: Item[] = []
  for (let i = 1; i <= 12; i += 1) items.push(engItem(i, 0.30 - i * 0.01, long))
  const h = makeHarness(items)
  await feedUser(h.listeners, '插件加载失败怎么办')
  const text = await assemble(h.listeners)
  const lines = text.split('\n').filter((l) => l.startsWith('- [knowledge|'))
  assert.ok(lines.length >= 5, '应注入多条（上限 5 槽位）')
  for (const line of lines) {
    const body = line.replace(/^- \[knowledge\|score=[0-9.]+\] /, '')
    assert.ok(!body.includes('\n'), '条目必须单行')
    assert.ok(body.length <= 121, `单条 ≤120 字符（实测 ${body.length}）：${body.slice(0, 20)}…`)
    assert.ok(body.endsWith('…'), '超长条目必须以省略号收尾（保留「被截断」这一事实）')
  }
  const blockBody = text.slice(text.indexOf('\n') + 1)
  assert.ok(blockBody.length <= 1200, `整块 ≤1200 字符（实测 ${blockBody.length}）`)
})