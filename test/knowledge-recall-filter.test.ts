/**
 * knowledge-recall-filter.test.ts · 【灵枢交易教训】候选过滤的生产路径守卫
 *
 * 守什么（2026-10-07 语料事故的直接回归，全部为此前无测试覆盖的死区）：
 *   1. 日志节点（正文含「## yyyy-mm-dd」日志段）不注入；已确认教训（correction）
 *      即便含日期段也**必须**注入——黑名单按内容匹配时先豁免教训，避免误杀
 *      （语料里恰有 2 个 correction 节点带日期段，旧版正则按 id/内容一刀切会挡掉）。
 *   2. code_/doc_ 节点不注入；score < 0.1 不注入；同摘要 160 字去重；上限 5 条。
 *   3. knowledge 召回出口只传 md_cg/protocol.py「read」白名单内的参数
 *      （{ k, layer }）。事故记录：上一稿曾改走 graph.recall 并传
 *      paths=[...,'semantic']，read 处理器与协议白名单都不收——被静默丢弃、
 *      semantic 从未参与召回（A/B 逐位相同），且撞坏 session-attribution ⑦。
 *
 * 走的是**真生产路径**：installMemoryHooks 的 session/event → system-prompt/assemble。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { installMemoryHooks } from '../src/hooks.ts'

interface Assembly {
  contexts: Array<{ name: string; text: string }>
  variables: Record<string, string>
}

interface ReadCall { extra: Record<string, unknown> }

function makeHarness(results: unknown[]): {
  listeners: Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>
  readCalls: ReadCall[]
} {
  const listeners = new Map<string, (a: Assembly, c: unknown, n: () => Promise<unknown>) => Promise<unknown>>()
  const readCalls: ReadCall[] = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: never) { listeners.set(ev, fn as never) },
  } as never
  const client = {
    isReady: () => true,
    async timeline() { return { count: 0, limit: 4, items: [] as unknown[] } },
    async remember() { return { ok: true } },
    async read(_query: string, extra: Record<string, unknown> = {}) {
      readCalls.push({ extra })
      return { results }
    },
    async recall() { return { ok: true } },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
  })
  return { listeners, readCalls }
}

/** 模拟 cg(op=read) 单条结果（mcp_server read 面的 results 元素形状）。 */
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

const LOG_CONTENT = [
  '# 功能名 市场洞察（每日追加）',
  '# 生效条件',
  '复盘/分析时适用',
  '## 2026-07-31 周五',
  '- 亏损全部来自无信号买入：中际旭创 -9180',
].join('\n')

const LESSON_WITH_DATE = [
  '# 功能名 [confirmed] 结论先于分析(预设推荐股)',
  '# 生效条件',
  '复盘/分析时适用',
  '## 2026-08-20 结论先于分析(预设推荐股) - 已机器拦截根治',
  '教训：没拿到当日数据就先给结论，被用户当场点破。',
].join('\n')

const PLAIN_LESSON = [
  '# 功能名 R003 突破追高被套',
  '# 生效条件',
  '复盘/分析时适用',
  '教训：集合竞价追高 R003，当日冲高回落，止损纪律执行不到位。',
].join('\n')

const HARD_RULE = [
  '# 功能名 Hard Rule #14: 每日三省吾身 + 轮动检查',
  '# 生效条件',
  '复盘/分析时适用',
  '执行：逐条核对，确认本次是否重犯。',
].join('\n')

const DUP_A = '# 功能名 重复摘要节点A\n正文：同一段摘要用于去重验证，超过二十个字符即可。'
const DUP_B = '# 功能名 重复摘要节点A\n正文：同一段摘要用于去重验证，超过二十个字符即可。'

test('生产路径候选过滤：日志节点挡、correction 豁免、code/低分/去重生效、只传白名单参数', async () => {
  const results = [
    item('knowledge/orphan/mem_logdaily0001.md', 0.35, ['市场洞察', '主线'], LOG_CONTENT),
    item('mem_lessonwithdate01.md', 0.25, ['correction', '已确认教训'], LESSON_WITH_DATE),
    item('mem_plainlesson00001.md', 0.20, ['correction', '已确认教训'], PLAIN_LESSON),
    item('mem_hardrule0000001.md', 0.30, ['hard_rule', '铁律'], HARD_RULE),
    item('code_abc123.md', 0.90, ['code:function'], 'export function foo(a) { return a } 通用词'),
    item('mem_lowscore000001.md', 0.05, ['correction', '已确认教训'], PLAIN_LESSON + '（低分副本）'),
    item('mem_dup_a.md', 0.15, ['correction'], DUP_A),
    item('mem_dup_b.md', 0.15, ['correction'], DUP_B),
  ]
  const { listeners, readCalls } = makeHarness(results)

  // ① 先喂一条真实用户消息（生产路径：session/event user/message → lastUserMsg）
  const onSession = listeners.get('session/event')
  assert.ok(onSession, '应注册 session/event 监听')
  await onSession({ id: 's-test-1' }, {
    type: 'user/message',
    data: {
      source: { kind: 'user' },
      content: [{ type: 'text', text: '追高买入之后止损怎么设' }],
    },
  } as never, async () => undefined as never)

  // ② 组装 system prompt → 触发 knowledge 召回与过滤
  const onAssemble = listeners.get('system-prompt/assemble')
  assert.ok(onAssemble, '应注册 system-prompt/assemble 监听')
  const assembly: Assembly = { contexts: [{ name: 'clock', text: '当前时间 12:00' }], variables: {} }
  await onAssemble(assembly, {}, async () => assembly)

  // ③ 契约：knowledge 召回只允许 protocol.read 白名单参数（{k, layer}），paths 必须缺席
  // （同轮还有 memorize 的 user-recall g.read({k, session})，一并核对会话槽）
  assert.equal(readCalls.length, 2, 'user 路应各触发一次 user-recall read + 一次 knowledge read')
  const userRead = readCalls.find((c) => c.extra['session'] === 's-test-1')
  assert.ok(userRead, 'user-recall read 应带会话槽')
  const knowledgeRead = readCalls.find((c) => c.extra['layer'] === 'knowledge')
  assert.ok(knowledgeRead, '应触发一次 layer=knowledge 的 read')
  const extra = knowledgeRead!.extra
  assert.deepEqual(Object.keys(extra).sort(), ['k', 'layer'], 'read extra 只允许 {k, layer}（paths 已撤回）')
  assert.equal(extra['k'], 16, 'k=16')
  assert.equal(extra['layer'], 'knowledge', '必须限定 knowledge 层（否则 contextual 回声顶掉教训）')
  assert.ok(!('paths' in extra), '不得传 paths：read 面不收该参数（2026-10-07 静默丢参事故）')

  // ④ 注入块内容断言
  const block = assembly.contexts.find((c) => c.name === 'lingshu:knowledge-recall')
  assert.ok(block, '应注入【灵枢交易教训】块')
  const text = block!.text
  assert.ok(text.includes('结论先于分析'), 'correction 教训（带日期段）必须注入——黑名单豁免')
  assert.ok(text.includes('R003'), '普通 correction 教训必须注入')
  assert.ok(text.includes('每日三省'), 'hard_rule 仍可注入（允许池，非黑名单对象）')
  assert.ok(!text.includes('市场洞察（每日追加）'), '日志节点必须被黑名单挡下')
  assert.ok(!text.includes('export function foo'), 'code_ 节点必须排除')
  assert.ok(!text.includes('低分副本'), 'score<0.1 必须排除')
  const lines = text.match(/- \[knowledge\|/g) || []
  assert.equal(lines.length, 4, '去重后应为 4 条（log/code/低分排除 + 同摘要 160 字去重收 1 条）')
  assert.ok(lines.length <= 5, '注入上限 5 条')
})
