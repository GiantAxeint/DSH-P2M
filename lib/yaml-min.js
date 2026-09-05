// yaml-min.js — loader 补丁方言的 YAML 子集解析器（只读，零依赖）
//
// 为什么自带解析器而不是依赖 npm 的 yaml：
//   1) A 插件自身“绝不能制造冲突”——零运行时依赖意味着不可能和任何插件
//      的依赖树打架（DESIGN 8.1）。
//   2) 我们要解析/写入的只有 Cordis loader 补丁这一种方言（块式映射/序列、
//      引号、注释、!!js 标签），完整 YAML 能力（锚点/别名/流式/多行块标量）
//      用不到。
// 范围外语法遇到时：不抛错，尽量按最宽容的方式读成字符串（保底可读性），
// 解析不了的层由调用方降级为“不可读”并记 incident（DESIGN 11 风险表）。

import { isPlainObject } from './util.js'

const JS_TAG = '__jsExpr'
export { JS_TAG }

/** 去掉行尾注释（尊重单双引号内不视为注释）。 */
function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i++
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

/** 找键值冒号（要求冒号后是空白/结尾/注释，避免命中 URL 里的冒号）。 */
function findColon(content) {
  let quote = null
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i++
    } else if (ch === "'" || ch === '"') {
      quote = ch
    } else if (ch === ':' && (i + 1 >= content.length || /\s/.test(content[i + 1]) || content[i + 1] === '#')) {
      return i
    }
  }
  return -1
}

function unquote(raw) {
  if (raw.length >= 2 && raw[0] === "'" && raw.endsWith("'")) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  if (raw.length >= 2 && raw[0] === '"' && raw.endsWith('"')) {
    try { return JSON.parse(raw) } catch { return raw.slice(1, -1) }
  }
  return raw
}

/** 纯文本 scalar → JS 值（仅认识 true/false/null/数字/!!js；引号包裹则先解码）。 */
function parseScalar(value) {
  const v = unquote(value)
  if (v.startsWith('!!js ')) {
    return { [JS_TAG]: v.slice(5).trim() }
  }
  if (v === 'true') return true
  if (v === 'false') return false
  if (v === 'null' || v === '~' || v === '') return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

const startsSeq = (c) => c === '-' || c.startsWith('- ')

/**
 * 解析整份补丁文本 → JS 值。根必须是数组（loader 补丁方言）；
 * 解析器不强制根类型，由调用方校验。
 */
export function parseDocument(text) {
  const source = String(text).replace(/^\uFEFF/, '').split(/\r?\n/)
  const lines = []
  for (let i = 0; i < source.length; i++) {
    const raw = source[i]
    const indent = raw.match(/^\s*/)[0].length
    const content = stripComment(raw.slice(indent)).trimEnd()
    if (!content.trim()) continue
    lines.push({ indent, content: content.trim(), line: i + 1 })
  }
  if (!lines.length) return []
  // 空 guard 是单行 `[]`
  if (lines.length === 1 && lines[0].content === '[]') return []
  if (lines.length === 1 && /^\[.*\]$/.test(lines[0].content)) return [] // 非空流式：本方言不应出现，宽容降级
  const parsed = parseValue(lines, 0, 0)
  return parsed.node
}

/** 从 lines[i] 解析一个值节点（映射/序列/标量），返回消费到的下一行下标。 */
function parseValue(lines, i, depth) {
  if (depth > 200) throw new Error('yaml-min: nesting too deep (possible unclosed block)')
  if (i >= lines.length) return { node: null, next: i }
  const l = lines[i]
  if (startsSeq(l.content)) return parseSeq(lines, i, depth)
  if (findColon(l.content) >= 0) return parseMap(lines, i, depth)
  return { node: parseScalar(l.content), next: i + 1 }
}

/** 序列：从 indent=seqIndent 的一串 `- ` 行开始。 */
function parseSeq(lines, start, depth) {
  const arr = []
  const seqIndent = lines[start].indent
  let i = start
  let guard = 0
  while (i < lines.length && lines[i].indent === seqIndent && startsSeq(lines[i].content) && guard++ < 100_000) {
    const rest = lines[i].content.slice(1).trim()
    const itemIndent = lines[i].indent
    i++
    if (rest === '') {
      // `-` 裸项：可能后面跟着更深的键（item map 的另一种写法）
      if (i < lines.length && lines[i].indent > itemIndent) {
        const obj = {}
        i = parseMapInto(lines, i, obj, depth)
        arr.push(Object.keys(obj).length ? obj : null)
      } else {
        arr.push(null)
      }
      continue
    }
    const colon = findColon(rest)
    if (colon < 0) {
      // 纯标量项
      arr.push(parseScalar(rest))
      continue
    }
    // `- key: ...` 或 `- key:` → 该项是一个映射，首键来自 rest，续键缩进更深
    const key = unquote(rest.slice(0, colon).trim())
    const firstValue = rest.slice(colon + 1).trim()
    const obj = {}
    if (firstValue !== '') {
      obj[key] = parseScalar(firstValue)
    } else if (i < lines.length && lines[i].indent > itemIndent) {
      const { node, next } = parseValue(lines, i, depth + 1)
      obj[key] = node
      i = next
    } else {
      obj[key] = null
    }
    // `- id: x` 后跟更深键行（如 config:/disabled:）→ 同项映射的其余部分，合并进来
    if (i < lines.length && lines[i].indent > itemIndent) {
      i = parseMapInto(lines, i, obj, depth)
    }
    arr.push(obj)
  }
  return { node: arr, next: i }
}

/** 映射：从 start 处（键行）开始，直到缩进 < base 或同级 '-' 为止。 */
function parseMap(lines, start, depth) {
  const obj = {}
  const next = parseMapInto(lines, start, obj, depth)
  return { node: obj, next }
}

function parseMapInto(lines, start, obj, depth) {
  if (start >= lines.length) return start // 没有续行：无事可做
  const base = lines[start].indent
  let i = start
  let guard = 0
  while (i < lines.length && guard++ < 100_000) {
    const l = lines[i]
    if (l.indent < base) break
    if (l.indent > base) { i++; continue } // 异常缩进，跳过保底
    if (startsSeq(l.content)) break // 同级 '-'：属于外层序列，交回
    const colon = findColon(l.content)
    if (colon < 0) { i++; continue }
    const key = unquote(l.content.slice(0, colon).trim())
    const value = l.content.slice(colon + 1).trim()
    i++
    if (value !== '') {
      obj[key] = parseScalar(value)
      continue
    }
    if (i < lines.length && lines[i].indent > base) {
      const { node, next } = parseValue(lines, i, depth + 1)
      obj[key] = node
      i = next
    } else {
      obj[key] = null
    }
  }
  return i
}

/** 判断某 JS 值是否是 !!js 表达式包装。 */
export function jsExprOf(value) {
  return isPlainObject(value) && JS_TAG in value ? value[JS_TAG] : null
}

/** 把补丁文本解析成 JS 值；失败返回 { error }，由调用方降级处理。 */
export function safeParse(text) {
  try {
    return { value: parseDocument(text) }
  } catch (error) {
    return { error }
  }
}
