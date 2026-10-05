import { MODULE_BY_KEY } from '@/data/modules'
import { allRows, listRows, resetRows, saveRows } from '@/data/local-store'
import { custodyOf, inHandover } from '@/data/stations'
import type {
  ActionResult,
  EntryRow,
  ModuleMeta,
  OperatorContext,
  OverviewResult,
  PageResult,
} from '@/data/types'

// 会写进数据的「往回走」动作：命中就把这条记录标成异常态，看板上能一眼看出来。
const NEGATIVE_ACTIONS = ['撤销', '作废', '拒绝', '驳回', '停用', '忽略', '下线', '回滚']

// 雨量监测审核流：已采集 →(乡镇站员提交) 待复核 →(区县复核) 已审核/达预警值；复核驳回退回已采集。
const RAIN_KEY = 'rain_gauge'
const RAIN_REVIEW_ACTIONS = ['复核通过', '复核驳回']

export function moduleMeta(key: string): ModuleMeta {
  const meta = MODULE_BY_KEY.get(key)
  if (!meta) {
    throw new Error(`没有登记名为 ${key} 的业务模块`)
  }
  return meta
}

export function filterRows(rows: EntryRow[], filters: Record<string, string>): EntryRow[] {
  const pairs = Object.entries(filters).filter(([, value]) => value.trim() !== '')
  if (pairs.length === 0) {
    return rows
  }
  return rows.filter((row) =>
    pairs.every(([field, value]) => String(row[field] ?? '').includes(value.trim())),
  )
}

export function listEntries(key: string, filters: Record<string, string> = {}): PageResult {
  const matched = filterRows(listRows(key), filters)
  return { items: matched, total: matched.length, page: 1, size: matched.length }
}

export function runAction(
  key: string,
  id: number,
  action: string,
  ctx?: OperatorContext,
): ActionResult {
  if (key === RAIN_KEY) {
    return runRainAction(id, action, ctx)
  }
  const meta = moduleMeta(key)
  const target = meta.actionTargets[action]
  if (!target) {
    return { ok: false, message: `${meta.entity}没有登记「${action}」这个动作` }
  }
  const rows = listRows(key)
  const index = rows.findIndex((row) => Number(row.id) === id)
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的${meta.entity}` }
  }
  const current = String(rows[index].status)
  if (current === target) {
    return { ok: false, message: `${meta.entity}已经是「${target}」，不用重复操作` }
  }
  const lastStatus = meta.statuses[meta.statuses.length - 1]
  const updated: EntryRow = {
    ...rows[index],
    status: target,
    pending: target !== lastStatus,
    abnormal: NEGATIVE_ACTIONS.some((verb) => action.startsWith(verb)),
  }
  const next = [...rows]
  next[index] = updated
  saveRows(key, next)
  return { ok: true, message: `${meta.entity}已${action}，当前状态「${target}」` }
}

// 页面按当前身份渲染可执行动作；真正的权限校验仍在 runAction / registerRainEntry 里。
export function listRowActions(key: string, row: EntryRow, ctx?: OperatorContext): string[] {
  if (key !== RAIN_KEY) {
    return moduleMeta(key).actions
  }
  if (!ctx) {
    return []
  }
  if (ctx.role === 'county') {
    // 区县人员只读，仅对待复核记录执行复核动作
    return String(row.status) === '待复核' ? [...RAIN_REVIEW_ACTIONS, '标记异常'] : []
  }
  if (String(row.status) === '已采集' && String(row['归属乡镇'] ?? '') === ctx.township) {
    return ['提交审核']
  }
  return []
}

export type RainEntryInput = {
  站点编号: string
  观测时段: string
  时段雨量: string
  日累计雨量: string
  小时最大雨强: string
}

// 乡镇站员登记本辖区雨量记录：站点必须在本辖区代管权内，跨辖区一律拒绝。
export function registerRainEntry(input: RainEntryInput, ctx?: OperatorContext): ActionResult {
  if (!ctx || !ctx.operator.trim()) {
    return { ok: false, message: '未获取到当前值班身份，无法登记雨量记录' }
  }
  if (ctx.role !== 'township') {
    return { ok: false, message: '区县人员只读并负责复核，不能登记雨量记录' }
  }
  const custody = custodyOf(input.站点编号.trim())
  if (!custody) {
    return { ok: false, message: `站点 ${input.站点编号} 未登记代管权，拒绝登记` }
  }
  if (custody.所属乡镇 !== ctx.township) {
    return {
      ok: false,
      message: `站点 ${custody.站点编号} 属「${custody.所属乡镇}」，跨辖区登记一律拒绝`,
    }
  }
  const rainfall = Number(input.时段雨量)
  if (!input.观测时段.trim() || !Number.isFinite(rainfall) || rainfall < 0) {
    return { ok: false, message: '请填写观测时段和有效的时段雨量（不小于 0 的数字）' }
  }
  const rows = listRows(RAIN_KEY)
  const record: EntryRow = {
    id: nextId(rows),
    status: '已采集',
    pending: true,
    abnormal: false,
    记录编号: nextCode(rows, '记录编号', 'RAIN'),
    站点编号: custody.站点编号,
    // 归属在登记时快照固化：之后站点移交，历史记录仍按原归属显示
    归属乡镇: custody.所属乡镇,
    观测时段: input.观测时段.trim(),
    时段雨量: rainfall,
    日累计雨量: Number(input.日累计雨量) || rainfall,
    小时最大雨强: Number(input.小时最大雨强) || 0,
    是否触发预警: '否',
    登记人: ctx.operator,
    审核备注: inHandover(custody) ? '站点交接中暂无负责人，提交审核将转交区县待办' : '',
    记录状态: '已采集',
    审核结果: '',
    区县待办: false,
  }
  saveRows(RAIN_KEY, [...rows, record])
  return { ok: true, message: `已登记雨量记录 ${record['记录编号']}（归属${custody.所属乡镇}）` }
}

function runRainAction(id: number, action: string, ctx?: OperatorContext): ActionResult {
  const rows = listRows(RAIN_KEY)
  const row = rows.find((item) => Number(item.id) === id)
  if (!row) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  if (!ctx || !ctx.operator.trim()) {
    return { ok: false, message: '未获取到当前值班身份，无法操作雨量记录' }
  }
  const status = String(row.status)
  const owner = String(row['归属乡镇'] ?? '')
  const save = (updated: EntryRow) =>
    saveRows(RAIN_KEY, rows.map((item) => (Number(item.id) === id ? updated : item)))

  if (action === '提交审核') {
    if (ctx.role !== 'township') {
      return { ok: false, message: '区县人员只读并负责复核，不能提交审核' }
    }
    if (!owner || owner !== ctx.township) {
      return { ok: false, message: `该记录归属「${owner || '未登记辖区'}」，跨辖区操作一律拒绝` }
    }
    if (status !== '已采集') {
      return { ok: false, message: `仅「已采集」记录可提交审核，当前状态「${status}」` }
    }
    // 交接期间无负责人：转交区县待办，而不是放行
    const handover = inHandover(custodyOf(String(row['站点编号'] ?? '')))
    save({
      ...row,
      status: '待复核',
      pending: true,
      abnormal: false,
      区县待办: handover,
      审核备注: appendNote(
        row['审核备注'],
        handover ? '站点交接中暂无负责人，转交区县待办复核' : `${ctx.operator}提交审核`,
      ),
    })
    return {
      ok: true,
      message: handover
        ? '已提交审核；站点交接中无负责人，记录已转交区县待办，不会自动放行'
        : '已提交审核，等待区县复核',
    }
  }

  if (RAIN_REVIEW_ACTIONS.includes(action)) {
    if (ctx.role !== 'county') {
      return { ok: false, message: '仅区县人员可复核雨量记录' }
    }
    if (status !== '待复核') {
      // 幂等：同一审核结果重复提交只保留一次
      if (String(row['审核结果'] ?? '') === action) {
        return {
          ok: false,
          message: `该记录已「${action}」，同一审核结果只保留一次，重复提交已忽略`,
        }
      }
      return { ok: false, message: `仅「待复核」记录可复核，当前状态「${status}」` }
    }
    if (action === '复核驳回') {
      save({
        ...row,
        status: '已采集',
        pending: true,
        abnormal: false,
        审核结果: action,
        复核人: ctx.operator,
        区县待办: false,
        审核备注: appendNote(row['审核备注'], `${ctx.operator}复核驳回，退回登记人修改`),
      })
      return { ok: true, message: '已驳回，记录退回乡镇登记人修改' }
    }
    // 人工复核是放行闸门：复核通过后才按已生效雨量阈值自动定级（多级别取最高）
    const hit = evaluateRainLevel(row)
    const updated: EntryRow = {
      ...row,
      status: hit ? '达预警值' : '已审核',
      pending: true,
      abnormal: false,
      是否触发预警: hit ? '是' : '否',
      审核结果: action,
      复核人: ctx.operator,
      区县待办: false,
      审核备注: appendNote(
        row['审核备注'],
        hit
          ? `${ctx.operator}复核通过，达${hit.level}阈值（${hit.limit}mm）`
          : `${ctx.operator}复核通过，未达预警阈值`,
      ),
    }
    save(updated)
    if (!hit) {
      return { ok: true, message: '复核通过，记录已审核，未达预警阈值' }
    }
    const created = ensureAlarmNotice(updated, hit, ctx.operator)
    return {
      ok: true,
      message: created
        ? `复核通过，记录达预警值（${hit.level}），预警发布页已生成待发布通知`
        : `复核通过，记录达预警值（${hit.level}），待发布通知已存在，未重复生成`,
    }
  }

  if (action === '标记异常') {
    if (ctx.role !== 'county') {
      return { ok: false, message: '仅区县人员可标记异常雨量记录' }
    }
    if (status === '异常值') {
      return { ok: false, message: '雨量记录已经是「异常值」，不用重复操作' }
    }
    save({
      ...row,
      status: '异常值',
      pending: false,
      abnormal: true,
      审核备注: appendNote(row['审核备注'], `${ctx.operator}标记异常`),
    })
    return { ok: true, message: '雨量记录已标记异常' }
  }

  return { ok: false, message: `雨量记录没有登记「${action}」这个动作` }
}

// 阈值定级：取 threshold 模块里「已生效」的雨量阈值，雨量达到多个级别时按最高级别定。
function evaluateRainLevel(row: EntryRow): { level: string; value: number; limit: number } | null {
  const rainfall = Number(row['时段雨量'])
  if (!Number.isFinite(rainfall)) {
    return null
  }
  const config = listRows('threshold').find(
    (item) => item.status === '已生效' && String(item['监测类型'] ?? '').includes('雨量'),
  )
  if (!config) {
    return null
  }
  const tiers: [string, string][] = [
    ['警戒级', '警戒级阈值'],
    ['警示级', '警示级阈值'],
    ['注意级', '注意级阈值'],
  ]
  for (const [level, field] of tiers) {
    const limit = Number(config[field])
    if (Number.isFinite(limit) && rainfall >= limit) {
      return { level, value: rainfall, limit }
    }
  }
  return null
}

// 审核通过且达预警值时在预警发布模块生成「待发布」通知；同一雨量记录只生成一次。
function ensureAlarmNotice(
  record: EntryRow,
  hit: { level: string; value: number; limit: number },
  reviewer: string,
): boolean {
  const alarms = listRows('alarm')
  const source = String(record['记录编号'] ?? '')
  if (alarms.some((item) => String(item['来源记录'] ?? '') === source)) {
    return false
  }
  const notice: EntryRow = {
    id: nextId(alarms),
    status: '待发布',
    pending: true,
    abnormal: false,
    通知编号: nextCode(alarms, '通知编号', 'ALAR'),
    隐患点编号: String(record['站点编号'] ?? ''),
    预警等级: hit.level,
    触发条件: `雨量记录${source} 时段雨量${hit.value}mm 达${hit.level}阈值（${hit.limit}mm）`,
    发布时间: '',
    接收单位: `${String(record['归属乡镇'] ?? '')}人民政府`,
    发布人: reviewer,
    通知状态: '待发布',
    来源记录: source,
  }
  saveRows('alarm', [...alarms, notice])
  return true
}

function appendNote(current: unknown, note: string): string {
  const text = String(current ?? '').trim()
  if (!note) {
    return text
  }
  return text ? `${text}；${note}` : note
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const pattern = new RegExp(`^${prefix}-(\\d+)$`)
  const max = rows.reduce((acc, row) => {
    const match = pattern.exec(String(row[field] ?? ''))
    return match ? Math.max(acc, Number(match[1])) : acc
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

export function resetModule(key: string): PageResult {
  resetRows(key)
  return listEntries(key)
}

export function exportEntries(key: string): { filename: string; content: string } {
  const meta = moduleMeta(key)
  const header = ['编号', ...meta.fields, '当前状态']
  const lines = [header.join(',')]
  for (const row of listRows(key)) {
    lines.push([row.id, ...meta.fields.map((field) => row[field] ?? ''), row.status].join(','))
  }
  return { filename: `${meta.name}-清单.csv`, content: `\uFEFF${lines.join('\n')}` }
}

export function downloadEntries(key: string): void {
  const { filename, content } = exportEntries(key)
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export function loadOverview(): OverviewResult {
  const rows = allRows()
  const modules = [...MODULE_BY_KEY.values()].map((meta) => {
    const entries = rows[meta.key] ?? []
    return {
      name: meta.name,
      created: entries.length,
      pending: entries.filter((row) => row.pending).length,
      abnormal: entries.filter((row) => row.abnormal).length,
    }
  })
  const cards = [
    { label: '业务模块', value: modules.length },
    { label: '登记总量', value: modules.reduce((sum, item) => sum + item.created, 0) },
    { label: '待处理', value: modules.reduce((sum, item) => sum + item.pending, 0) },
    { label: '异常量', value: modules.reduce((sum, item) => sum + item.abnormal, 0) },
  ]
  return { cards, modules }
}
