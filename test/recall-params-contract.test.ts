/**
 * recall-params-contract.test.ts · 跨层调用参数契约（fail-loud）
 *
 * 事故背景（2026-10-07）：src/hooks.ts 曾给 graph.recall 传
 * `paths: ['lexical', ..., 'semantic']`，但 md_cg/protocol.py「read」面的
 * optional 白名单与 mcp_server.py 的 cg(op=read) 处理器都不收该参数——
 * 参数被**静默丢弃**，semantic 召回从未生效，两侧测试却各自全绿。
 *
 * 本契约：hooks 里 graph.recall / graph.read 的**字面量 options 键**必须全部
 * ∈ protocol.py read 面 optional 白名单。谁再加未声明参数（或给协议加参数却
 * 没接线）都会在这里立刻变红，而不是在生产里空转。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析 protocol.py 中 "read" 声明的 optional 参数元组 → 键集合。 */
function protocolReadOptional(): Set<string> {
  const src = readFileSync(join(repoRoot, 'md_cg', 'protocol.py'), 'utf8')
  const verbIdx = src.indexOf('"read": {')
  assert.ok(verbIdx >= 0, 'protocol.py 应声明 "read": { … } 动词块')
  const optIdx = src.indexOf('"optional"', verbIdx)
  assert.ok(optIdx > verbIdx, 'read 面应有 "optional" 声明')
  const endIdx = src.indexOf('),', optIdx)
  assert.ok(endIdx > optIdx, 'optional 元组应以 ), 收尾')
  const tuple = src.slice(optIdx, endIdx)
  const keys = new Set<string>()
  for (const m of tuple.matchAll(/"([A-Za-z_][A-Za-z0-9_]*)"/g)) keys.add(m[1])
  keys.delete('optional')
  return keys
}

interface CallSite { method: string; keys: string[]; snippet: string }

/** 抽取 src/hooks.ts 中 graph.recall(...) / graph.read(...) 调用的字面量 options 键。 */
function hookCallSites(): CallSite[] {
  const src = readFileSync(join(repoRoot, 'src', 'hooks.ts'), 'utf8')
  const out: CallSite[] = []
  // hooks.ts 里客户端的两个别名：外层 graph（knowledge 召回）与 memorize 回调参数 g（user-recall 的 g.read）
  const re = /\b(?:graph|g)\.(recall|read)\(/g
  for (const m of src.matchAll(re)) {
    const start = m.index! + m[0].length
    let depth = 1
    let j = start
    while (j < src.length && depth > 0) {
      const c = src[j]
      if (c === '(') depth++
      else if (c === ')') depth--
      j++
    }
    assert.ok(depth === 0, `括号不配对的调用点：${m[0]}@${m.index}`)
    const call = src.slice(start, j - 1)
    const braceStart = call.lastIndexOf('{')
    const braceEnd = call.lastIndexOf('}')
    let keys: string[] = []
    if (braceStart >= 0 && braceEnd > braceStart) {
      const obj = call.slice(braceStart + 1, braceEnd)
      for (const km of obj.matchAll(/(^|[\s,])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) keys.push(km[2])
    }
    out.push({ method: m[1], keys, snippet: `graph.${m[1]}(...)` })
  }
  return out
}

test('protocol.read 白名单可解析（layer/k/session 等已声明）', () => {
  const allowed = protocolReadOptional()
  for (const key of ['layer', 'k', 'session', 'context']) {
    assert.ok(allowed.has(key), `read optional 应含 ${key}（解析口径失效则本行红）`)
  }
  assert.ok(!allowed.has('paths'), '若协议将来真声明 paths，须同步接线 mcp_server read 处理器并更新本断言')
})

test('hooks 的 recall/read 字面量参数 ⊆ protocol.read 白名单（禁止静默丢参）', () => {
  const allowed = protocolReadOptional()
  const calls = hookCallSites()
  assert.ok(calls.length >= 1, 'src/hooks.ts 应至少有一处 graph.recall/read 调用（解析失效会漏检）')
  for (const c of calls) {
    for (const key of c.keys) {
      assert.ok(
        allowed.has(key),
        `${c.snippet} 传了 ${key}，但 protocol.py read 面白名单不含它——` +
        '处理器不会消费（静默丢参），要么删参数，要么在 protocol + mcp_server 两侧同时接线',
      )
    }
  }
  const recallPaths = calls.filter((c) => c.method === 'recall' && c.keys.includes('paths'))
  assert.equal(recallPaths.length, 0, 'recall 不得再传 paths（2026-10-07 semantic 空转事故，已撤回）')
})
