/**
 * inject_receipt.ts · 注入**回执**（每步一行 JSONL，诊断面）
 *
 * 病（2026-11-15 实测三次踩坑）：
 *   「本步到底注入了什么、route 是成功/空/失败、教训块是定版复用还是重选」这三件事
 *   此前**只存在于进程内**，宿主 `ctx.logger` 又不落盘。后果是验收只能靠猜：
 *   ① C5 第一轮我把「前 5 步没有路由块」断言成「失败被永久缓存」——错；
 *   ② 重启 #5 路由块没出现，我无法区分「成功但无能力命中」与「仍在失败」；
 *   ③ C6 跨会话串台只能事后靠 md_cg 的 `_access.log` 反推（那还是别人的日志）。
 *   审计文件 `dsh-memory-hook-audit.json` 只覆盖**写侧**（哪些消息被滤/写入），
 *   注入侧完全无痕。
 *
 * 本模块 = **注入侧盘面**，与 hook_audit 同目录同惯例：
 *   · 每次 system-prompt/assemble 落**一行** JSONL（追加式，转一圈即可读）；
 *   · 只记**结构**，不记正文：块名、条数、节点 id、route 状态与能力名——
 *     节点 id 是标识不是内容，正文仍只在提示词里；
 *   · 同步追加写（assemble 回调同步返回，异步写会乱序）；
 *   · 有界：单文件超过 MAX_BYTES 时滚动成 `<path>.1`（只保留上一代）；
 *   · 静默降级：任何失败都不冒泡（回执是增益，注入必须照常）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 缺省回执文件：与 hook-audit / 桥探针同目录同惯例（README.md:110）。 */
export const DEFAULT_INJECT_RECEIPT_PATH = join(homedir(), '.dsh', 'logs', 'dsh-memory-inject.jsonl')

/** 单文件上限（滚动阈值）：每步一行、几十字节，4 MB ≈ 数万步，够复盘好几个月的会话。 */
const MAX_BYTES = 4 * 1024 * 1024

/** route 的结果：成功有建议 / 成功无建议（缓存 ''）/ 失败 / 本步被节流跳过 / 命中上一步缓存。 */
export type RouteReceiptState = 'ok' | 'empty' | 'fail' | 'throttled' | 'cached' | 'skip'

/** 一步注入的回执（**结构，不含正文**）。 */
export interface InjectReceipt {
  /** ISO 时间。 */
  t: string
  /** 会话键（显式会话 id；取不到时 '__global__'）。 */
  sid: string
  /** 本步实际 push 的 lingshu:* 上下文块名（空数组 = 本步零注入）。 */
  blocks: string[]
  /** 教训块：条数 / 所选节点 id / 是否定版复用。null = 本步没有教训块。 */
  lesson: { n: number; ids: string[]; pinned: boolean } | null
  /** 路由起手：本步的 route 结局与能力名（null = 未参与）。 */
  route: { state: RouteReceiptState; caps: string[] } | null
  /** 错误摘要（route 失败时的 message；**不含用户/记忆正文**）。 */
  err?: string
}

/** 注入回执记录器（**静默降级**：构造函数与 log 都不会抛）。 */
export class InjectReceiptLogger {
  /** 实际生效的回执路径（构造时定死，供日志/测试核对）。 */
  readonly path: string
  /** 滚动阈值（测试可调小）。 */
  readonly maxBytes: number
  /** 调用方是否**显式**给了路径。 */
  readonly #explicitPath: boolean

  constructor(path?: string, maxBytes?: number) {
    this.#explicitPath = typeof path === 'string' && path.trim().length > 0
    this.path = this.#explicitPath ? (path as string).trim() : DEFAULT_INJECT_RECEIPT_PATH
    this.maxBytes = typeof maxBytes === 'number' && maxBytes > 0 ? maxBytes : MAX_BYTES
  }

  /** 追加一行回执；失败静默。返回是否写成功（仅供测试断言，生产忽略）。 */
  log(receipt: InjectReceipt): boolean {
    // 测试装配**不得**写进用户的真实日志目录（2026-11-15 实测：一次全量测试往
    // ~/.dsh/logs/dsh-memory-inject.jsonl 写了 117 行假回执，会污染验收读数）。
    // 判据用 node:test 的 NODE_TEST_CONTEXT（测试子进程必有，宿主进程必无）；
    // 显式传了路径的测试照常写（C4 自己的测试就是这么验的）。
    if (!this.#explicitPath && process.env.NODE_TEST_CONTEXT !== undefined) return false
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      this.#rotateIfNeeded()
      appendFileSync(this.path, `${JSON.stringify(receipt)}\n`, 'utf8')
      return true
    } catch {
      return false
    }
  }

  /** 读取全部回执（跳过坏行；文件不存在 → 空数组）。供测试与排查工具使用。 */
  read(): InjectReceipt[] {
    try {
      if (!existsSync(this.path)) return []
      const out: InjectReceipt[] = []
      for (const line of readFileSync(this.path, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as InjectReceipt
          if (r && typeof r.t === 'string') out.push(r)
        } catch { /* 坏行跳过：回执是追加式日志，宁可丢一行也不抛 */ }
      }
      return out
    } catch {
      return []
    }
  }

  /** 超过阈值 → 滚动成 `<path>.1`（只保留上一代；删除失败忽略）。 */
  #rotateIfNeeded(): void {
    if (!existsSync(this.path)) return
    if (statSync(this.path).size <= this.maxBytes) return
    const rolled = `${this.path}.1`
    try {
      if (existsSync(rolled)) unlinkSync(rolled)
    } catch { /* 旧世代删不掉就覆盖 */ }
    renameSync(this.path, rolled)
  }
}