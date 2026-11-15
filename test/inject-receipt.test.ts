/**
 * inject-receipt.test.ts · 注入回执（C4）
 *
 * 守什么：接入前，「本步注入了什么 / route 是成功、空、失败还是被节流 / 教训块是定版
 * 复用还是重选」只存在于进程内，宿主 logger 不落盘。后果实测过三次：
 *   · C5 第一轮我把「前 5 步没有路由块」错断成「失败被永久缓存」；
 *   · 重启 #5 路由块没出现，无法区分「成功但无能力命中」与「仍在失败」；
 *   · C6 跨会话串台只能靠 md_cg 的 `_access.log`（别人的日志）反推。
 * 回执落盘后，这些都变成可读的一行 JSON。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installMemoryHooks } from '../src/hooks.ts'
import { InjectReceiptLogger, DEFAULT_INJECT_RECEIPT_PATH } from '../src/lib/inject_receipt.ts'

interface Assembly {
  contexts: Array<{ name: string; text: string }>
  variables: Record<string, string>
}

const SID = 's-receipt-1'

function tmpFile(tag: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), `dsh-receipt-${tag}-`))
  return { dir, file: join(dir, 'inject.jsonl') }
}

function makeHarness(receiptPath: string, routeImpl: () => Promise<unknown>) {
  const listeners = new Map<string, (a?: unknown, b?: unknown, c?: unknown) => Promise<unknown>>()
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on(ev: string, fn: never) { listeners.set(ev, fn as never) },
  } as never
  const client = {
    isReady: () => true,
    async timeline() { return { count: 0, limit: 4, items: [] as unknown[] } },
    async remember() { return { ok: true } },
    async read() {
      return {
        results: [{
          node: {
            id: 'mem_receipt0001.md',
            content: '# 功能名 工程教训 1\n构建产物与源码不一致时，先核对符号链接目标。',
            frontmatter: { id: 'mem_receipt0001', tags: ['dsh'], access_count: 0 },
          },
          score: 0.3,
          state: 'ACCEPT',
        }],
      }
    },
    async recall() { return { ok: true } },
    async route() { return routeImpl() },
  }
  installMemoryHooks(ctx, client as never, {
    userMessage: true, assistantMessage: false, toolResult: false,
    importance: 0.6, autoRecall: true, autoRecallLimit: 4, desensitize: true,
    injectLogPath: receiptPath,
  })
  return listeners
}

async function feed(listeners: ReturnType<typeof makeHarness>, text: string): Promise<void> {
  const onSession = listeners.get('session/event')
  assert.ok(onSession)
  await onSession({ id: SID }, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
  }, async () => undefined)
}

async function assemble(listeners: ReturnType<typeof makeHarness>): Promise<Assembly> {
  const onAssemble = listeners.get('system-prompt/assemble')
  assert.ok(onAssemble)
  const assembly: Assembly = { contexts: [], variables: {} }
  await onAssemble(assembly, { agent: { session: { id: SID } } }, async () => assembly)
  return assembly
}

function readLines(file: string): Array<Record<string, any>> {
  return readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
}

test('C4 回执：每步一行，含 sid/块名/教训条数与节点 id/是否定版', async () => {
  const { dir, file } = tmpFile('basic')
  try {
    const listeners = makeHarness(file, async () => ({ suggested_capabilities: ['verify', 'remember'] }))
    await feed(listeners, '插件加载失败怎么办')
    await assemble(listeners)
    await assemble(listeners)

    const rows = readLines(file)
    assert.equal(rows.length, 2, '每步装配落一行')
    const first = rows[0]
    assert.equal(first.sid, SID, '回执带会话键（C6 之后会话是隔离维度）')
    assert.ok(Array.isArray(first.blocks))
    assert.ok(first.blocks.includes('lingshu:knowledge-recall'), '块名要能看出注入了什么')
    assert.equal(first.lesson.n, 1)
    assert.deepEqual(first.lesson.ids, ['mem_receipt0001'], '节点 id 是标识不是正文')
    assert.equal(first.lesson.pinned, false, '首步是重选')
    assert.equal(first.route.state, 'ok', 'route 成功且有建议')
    assert.deepEqual(first.route.caps, ['verify', 'remember'])

    const second = rows[1]
    assert.equal(second.lesson.pinned, true, '第二步命中定版（C2）')
    assert.equal(second.route.state, 'cached', 'route 结果按会话缓存后每步原样重推')

    // 隐私边界：回执是结构，不是记忆库副本
    const raw = readFileSync(file, 'utf8')
    assert.ok(!raw.includes('构建产物与源码不一致'), '回执不得包含记忆正文')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C4 回执：route 失败记 fail+err，节流窗内记 throttled（不再误判成"没试"）', async () => {
  const { dir, file } = tmpFile('fail')
  try {
    const listeners = makeHarness(file, async () => { throw new Error('桥未就绪 ENOENT') })
    await feed(listeners, '插件加载失败怎么办')
    await assemble(listeners)
    await assemble(listeners)   // 20s 节流窗内

    const rows = readLines(file)
    assert.equal(rows[0].route.state, 'fail', '失败必须留痕（旧版只有 ctx.logger.warn，不落盘）')
    assert.match(String(rows[0].err), /桥未就绪/, 'err 摘要用于区分失败原因')
    assert.equal(rows[1].route.state, 'throttled', '同一时刻第二步是被节流跳过，不是"又一次失败"')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C4 回执：route 成功但无能力命中记 empty（与 fail 分开）', async () => {
  const { dir, file } = tmpFile('empty')
  try {
    const listeners = makeHarness(file, async () => ({ suggested_capabilities: [] }))
    await feed(listeners, '插件加载失败怎么办')
    await assemble(listeners)
    await assemble(listeners)
    const rows = readLines(file)
    assert.equal(rows[0].route.state, 'empty', '「成功但没命中能力」必须能与「失败」区分')
    assert.deepEqual(rows[0].route.caps, [])
    assert.equal(rows[1].route.state, 'cached')
    assert.equal(rows[0].err, undefined, '成功路径不写 err')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('C4 回执：测试进程不往真实日志目录写（防污染验收读数）', () => {
  // 2026-11-15 实测事故：一次全量测试往 ~/.dsh/logs/dsh-memory-inject.jsonl 写了
  // 117 行假回执（sid=sess_A 之类），会直接把重启后的验收读数搅浑。
  assert.ok(process.env.NODE_TEST_CONTEXT, '本断言只在 node:test 子进程内成立')
  const logger = new InjectReceiptLogger()
  assert.equal(logger.path, DEFAULT_INJECT_RECEIPT_PATH, '默认路径仍是用户日志目录（生产用）')
  const ok = logger.log({ t: new Date().toISOString(), sid: 'test', blocks: [], lesson: null, route: null })
  assert.equal(ok, false, '未显式指定路径 + 测试进程 → 必须拒绝落盘')
})

test('C4 回执：单文件超阈值滚动成 .1，且坏行不炸读取', () => {
  const { dir, file } = tmpFile('rotate')
  try {
    const logger = new InjectReceiptLogger(file, 200)
    for (let i = 0; i < 12; i += 1) {
      logger.log({ t: new Date().toISOString(), sid: 'x', blocks: [], lesson: null, route: null })
    }
    assert.ok(existsSync(`${file}.1`), '超阈值必须滚动成 .1（回执是追加式日志，不能无限长）')
    writeFileSync(file, '{坏行}\n', { flag: 'a' })
    const rows = logger.read()
    assert.ok(rows.length > 0, '坏行跳过，其余照读')
    assert.ok(rows.every((r) => typeof r.t === 'string'))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})