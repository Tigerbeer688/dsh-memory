/**
 * knowledge-domain-cap.test.ts · 跨域回补硬上限（C1）的生产路径守卫
 *
 * 守什么（2026-11-15 审计事故的直接回归）：
 *   `MARKET_DOMAIN_RE` 域过滤（2026-11-09）只做 ×0.35 **降权**，而选择序的三轮里
 *   第二轮放开降权候选、第三轮再放开 recent——**都不限量**。于是同域候选不足 5 条时，
 *   降权项会一路填满全部槽位，域过滤整条作废。
 *   实测（86 会话 / 18,370 条注入项）：工程会话 session-4990 的 knowledge 块
 *   62.6% 是交易域（645 trade : 140 eng），全库注入项交易域占 72.2%。
 *   C1 给跨域回补加硬上限 CROSS_DOMAIN_MAX=1（≤20% 槽位），但**保留安全阀**：
 *   域判定误伤 / 全库只有跨域候选时仍要注入，不得退化成空块。
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

function makeHarness(results: unknown[]): {
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>
} {
  const listeners = new Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: never) { listeners.set(ev, fn as never) },
  } as never
  const client = {
    isReady: () => true,
    async timeline() { return { count: 0, limit: 4, items: [] as unknown[] } },
    async remember() { return { ok: true } },
    async read() { return { results } },
    async recall() { return { ok: true } },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
  })
  return { listeners }
}

function item(id: string, score: number, tags: string[], content: string, access = 0): unknown {
  return {
    node: {
      id,
      content,
      frontmatter: { id: id.replace(/\.md$/, ''), tags, access_count: access },
    },
    score,
    state: 'DEFER',
  }
}

/** 工程域条目：tags/正文都不命中 MARKET_DOMAIN_RE。 */
function engItem(n: number, score: number): unknown {
  return item(`mem_engplugin00000${n}.md`, score, ['dsh', 'plugin'],
    `# 功能名 插件加载失败排查 ${n}：pnpm 安装后 profile 未加载，检查 cordis.patch.yml 与 symlink 目标。`)
}

/** 交易域条目：正文命中 MARKET_DOMAIN_RE（仓位/止损/涨停）。 */
function tradeItem(n: number, score: number): unknown {
  return item(`mem_tradelesson000${n}.md`, score, ['correction', '已确认教训'],
    `# 功能名的第${n}条：追高买入后仓位过重、止损未执行，涨停次日回落。`)
}

async function assembleWith(query: string, results: unknown[]): Promise<string> {
  const { listeners } = makeHarness(results)
  const onSession = listeners.get('session/event')
  assert.ok(onSession, '应注册 session/event 监听')
  await onSession({ id: 's-cap-1' }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: query }] },
  } as never, async () => undefined as never)
  const onAssemble = listeners.get('system-prompt/assemble')
  assert.ok(onAssemble, '应注册 system-prompt/assemble 监听')
  const assembly: Assembly = { contexts: [], variables: {} }
  // C6：装配时必须带上**显式会话**（生产宿主在 ctx.agent.session 提供）；
  // 不带会话时插件不借用进程级单点缓存，本步不注入知识块。
  await onAssemble(assembly, { agent: { session: { id: 's-cap-1' } } } as never,
    async () => assembly)
  const block = assembly.contexts.find((c) => c.name === 'lingshu:knowledge-recall')
  assert.ok(block, '应注入【灵枢交易教训】块')
  return block!.text
}

const countTrade = (text: string): number => (text.match(/追高买入后仓位过重/g) || []).length
const countEng = (text: string): number => (text.match(/插件加载失败排查/g) || []).length

test('工程查询：同域 3 条 + 高降权项 → 跨域最多 1 条，不得填满槽位', async () => {
  // 交易域条目分数更高（0.30 vs 0.20），若无上限，第二轮会连填 2 个槽位
  const text = await assembleWith('插件加载失败怎么办', [
    engItem(1, 0.20), engItem(2, 0.18), engItem(3, 0.16),
    tradeItem(1, 0.30), tradeItem(2, 0.29), tradeItem(3, 0.28),
    tradeItem(4, 0.27), tradeItem(5, 0.26), tradeItem(6, 0.25),
  ])
  assert.equal(countEng(text), 3, '同域 3 条必须全部注入')
  assert.equal(countTrade(text), 1, '跨域回补硬上限 = 1（无上限时此处会是 2）')
  const lines = (text.match(/- \[knowledge\|/g) || []).length
  assert.equal(lines, 4, '共 4 条：3 同域 + 1 跨域补位')
  assert.ok(lines <= 5, '注入上限 5 条不变')
})

test('安全阀：全库只有跨域候选时仍注入 1 条，不得退化成空块', async () => {
  const text = await assembleWith('插件加载失败怎么办', [
    tradeItem(1, 0.30), tradeItem(2, 0.29), tradeItem(3, 0.28),
  ])
  assert.equal(countTrade(text), 1, '跨域上限 1 条——保留「域误伤不至于空块」的原安全阀')
  assert.equal(countEng(text), 0, '本场景无同域候选')
})

test('对照：交易域查询不降权，跨域上限不适用（原行为不变）', async () => {
  const text = await assembleWith('追高买入后止损和仓位怎么设', [
    tradeItem(1, 0.30), tradeItem(2, 0.29), tradeItem(3, 0.28),
    tradeItem(4, 0.27), tradeItem(5, 0.26), tradeItem(6, 0.25),
  ])
  assert.equal(countTrade(text), 5, 'query 命中交易域词 → 不降权 → 照旧填满 5 条')
})

/**
 * C1.5：只用交易语料的**新词**（收盘轮 / 闸门）表达、旧词表一个都不命中的条目。
 * 旧词表实测在真实交易域条目里漏检 12.5%（1,851/14,841），漏检使 C1 配额形同虚设。
 */
function tradeItemNewWords(n: number, score: number): unknown {
  return item(`mem_tradelessonv2_${n}.md`, score, ['correction', '已确认教训'],
    `# 功能名 收盘轮定稿 ${n}：本轮闸门全部通过，只做记录不下结论。`)
}
const countNewWordTrade = (text: string): number => (text.match(/收盘轮定稿/g) || []).length

test('域判据扩展（C1.5）：旧词表认不出的交易条目同样受跨域配额约束', async () => {
  const text = await assembleWith('插件加载失败怎么办', [
    engItem(1, 0.20), engItem(2, 0.18), engItem(3, 0.16),
    tradeItemNewWords(1, 0.30), tradeItemNewWords(2, 0.29),
    tradeItemNewWords(3, 0.28), tradeItemNewWords(4, 0.27),
  ])
  assert.equal(countEng(text), 3, '同域 3 条仍全部注入')
  assert.equal(countNewWordTrade(text), 1,
    '旧词表不认的「收盘轮/闸门」条目也必须算跨域——否则配额被绕过（实测漏检 12.5%）')
  // 负面断言：旧词表是否命中该条目不重要，重要的是它被算进了跨域池
  assert.ok(!/追高买入后仓位过重/.test(text), '本场景不含旧词条目')
})