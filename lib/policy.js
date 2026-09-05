// policy.js — 冲突裁决引擎（核心要求 2 的“决策中枢”）
//
// 输入：一条 Conflict + 当前排序快照（含 tier/usage）+ 配置；
// 输出：明确的 action —— report（只报告不动手）/ isolate（把 loser 隔离进
// guard）/ ignore（已一致，无需动作）。纯函数，单测覆盖裁决矩阵（DESIGN 6.3）。

import { TIER, tierOf, isProtected } from './priority.js'
import { KIND, SEVERITY } from './conflicts.js'

/**
 * 裁决一条冲突。
 * @param {object} conflict  来自 conflicts.js 的 Conflict（含 kind/entryId/layers）
 * @param {object} context
 * @param {{id:string,name?:string|null,tier:number}[]} context.order  已排序条目（含 tier）
 * @param {{entryId:string,packageName:string}} context.self
 * @param {{namePrefixes:string[],entryIds:string[]}} context.core
 * @param {{autoIsolate:boolean}} context.cfg
 * @returns {{action:'report'|'isolate'|'ignore', loserId?:string|null, reason:string}}
 */
export function decide(conflict, { order, self, core, cfg }) {
  const byId = new Map(order.map((e) => [e.id, e]))
  const related = [conflict.entryId, conflict.entryId2]
    .filter(Boolean)
    .map((id) => byId.get(id))
    .filter(Boolean)
  const protectedHit = related.some((e) => isProtected(e.tier ?? tierOf(e, self, core)))

  // 铁律：涉及 DSH 本体或 A 插件自身 → 永不自动隔离，只报告
  if (protectedHit) {
    return {
      action: 'report',
      loserId: null,
      reason: 'conflict involves DSH core or A-plugin itself — protected, never auto-isolated',
    }
  }

  // 结构性冲突（C3/C4/C5）：配置层打架，需要人来改，v1 一律只报告
  if (conflict.kind === KIND.CONFIG_CLASH || conflict.kind === KIND.DUP_ID || conflict.kind === KIND.DUP_NAME) {
    return {
      action: 'report',
      loserId: null,
      reason: `structural conflict (${conflict.kind}) requires manual fix; reported only`,
    }
  }

  // 运行期失败（C2 自动禁用未持久化 / C1 启动崩溃由启动器写）：
  // 默认把“已失败/被自动禁用者”固化进 guard（= 持久化 loader 既成事实）
  if (conflict.kind === KIND.AUTO_DISABLED || conflict.kind === KIND.BOOT_CRASH) {
    if (!cfg.autoIsolate) {
      return { action: 'report', loserId: conflict.entryId, reason: 'autoIsolate disabled; reported only' }
    }
    const loser = related.find((e) => e.id === conflict.entryId) ?? order.find((e) => e.id === conflict.entryId)
    if (!loser) return { action: 'ignore', loserId: null, reason: 'offender no longer in tree' }
    return {
      action: 'isolate',
      loserId: loser.id,
      reason: `entry "${loser.id}" failed/auto-disabled at runtime; persisting isolation in guard`,
    }
  }

  // 其他（C6 等）保守处理：报告
  return { action: 'report', loserId: null, reason: `kind ${conflict.kind} not auto-actionable; reported` }
}

export { SEVERITY }
