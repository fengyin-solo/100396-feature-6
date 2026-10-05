import { custodyOf, isHandoverWithoutCustodian } from '@/data/station-custody'
import { listRows, saveRows } from '@/data/local-store'
import type { ActionResult, EntryRow } from '@/data/types'

// 雨量监测的领域规则都收在这里：站点代管权、辖区校验、记录状态机、阈值定级、复核与预警联动。
// 定级原则：雨量值同时达到多个级别时，自动阈值定级优先（就高取值），人工复核只做通过/退回把关，
// 复核不能下调系统判定的等级，避免超限记录被人为降级。

export type SessionContext = {
  operator: string
  role: 'township' | 'county'
  township: string
}

export type RainRecordInput = {
  站点编号: string
  观测时段: string
  时段雨量: string
  日累计雨量: string
  小时最大雨强: string
}

const RAIN_KEY = 'rain_gauge'
const ALARM_KEY = 'alarm'
const THRESHOLD_KEY = 'threshold'

const LEVEL_ORDER = ['注意级', '警示级', '警戒级'] as const
type WarnLevel = (typeof LEVEL_ORDER)[number]

function now(): string {
  const d = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : NaN
}

function nextId(rows: EntryRow[]): number {
  return rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function nextCode(rows: EntryRow[], field: string, prefix: string): string {
  const max = rows.reduce((acc, row) => {
    const match = String(row[field] ?? '').match(/^([A-Z]+)-(\d+)$/)
    if (!match || match[1] !== prefix) {
      return acc
    }
    return Math.max(acc, Number(match[2]))
  }, 0)
  return `${prefix}-${String(max + 1).padStart(4, '0')}`
}

/** 预警阈值关联入口：站点专属已生效雨量阈值优先，没有则回落到「通用」雨量阈值。 */
export function effectiveThresholdFor(stationCode: string): EntryRow | undefined {
  const candidates = listRows(THRESHOLD_KEY).filter(
    (row) => String(row.status) === '已生效' && String(row['监测类型'] ?? '').includes('雨量'),
  )
  return (
    candidates.find((row) => String(row['隐患点编号']) === stationCode) ??
    candidates.find((row) => String(row['隐患点编号']) === '通用')
  )
}

/** 自动定级：时段雨量达到多个级别时就高取值；未达注意级返回空串。 */
export function evaluateRainLevel(periodRain: number, threshold: EntryRow | undefined): WarnLevel | '' {
  if (!threshold || !Number.isFinite(periodRain)) {
    return ''
  }
  let hit: WarnLevel | '' = ''
  for (const level of LEVEL_ORDER) {
    const limit = toNumber(threshold[`${level}阈值`])
    if (Number.isFinite(limit) && periodRain >= limit) {
      hit = level
    }
  }
  return hit
}

function findRecord(id: number): { rows: EntryRow[]; index: number } | undefined {
  const rows = listRows(RAIN_KEY)
  const index = rows.findIndex((row) => Number(row.id) === id)
  return index < 0 ? undefined : { rows, index }
}

function assertTownship(session: SessionContext): ActionResult | undefined {
  if (session.role !== 'township') {
    return { ok: false, message: '区县人员只读并负责复核，不能登记或流转雨量记录' }
  }
  return undefined
}

/** 跨辖区校验：一律拒绝。归属以记录上登记的辖区乡镇为准，历史记录不随代管关系调整改口。 */
function assertJurisdiction(row: EntryRow, session: SessionContext): ActionResult | undefined {
  const belong = String(row['辖区乡镇'] ?? '')
  if (belong && belong !== session.township) {
    return { ok: false, message: `跨辖区操作一律拒绝：记录归属${belong}，当前身份为${session.township}站员` }
  }
  return undefined
}

export function registerRainRecord(input: RainRecordInput, session: SessionContext): ActionResult {
  const denied = assertTownship(session)
  if (denied) {
    return denied
  }
  const custody = custodyOf(input.站点编号)
  if (!custody) {
    return { ok: false, message: `站点编号 ${input.站点编号} 未登记代管权，不能登记雨量记录` }
  }
  if (custody.所属乡镇 !== session.township) {
    return { ok: false, message: `跨辖区操作一律拒绝：站点 ${input.站点编号} 属${custody.所属乡镇}` }
  }
  const periodRain = toNumber(input.时段雨量)
  if (!Number.isFinite(periodRain) || periodRain < 0) {
    return { ok: false, message: '时段雨量必须是不小于 0 的数字' }
  }
  const threshold = effectiveThresholdFor(input.站点编号)
  const level = evaluateRainLevel(periodRain, threshold)
  const rows = listRows(RAIN_KEY)
  const record: EntryRow = {
    id: nextId(rows),
    status: '已采集',
    pending: true,
    abnormal: false,
    记录编号: nextCode(rows, '记录编号', 'RAIN'),
    站点编号: input.站点编号,
    观测时段: input.观测时段,
    时段雨量: periodRain,
    日累计雨量: toNumber(input.日累计雨量) || 0,
    小时最大雨强: toNumber(input.小时最大雨强) || 0,
    是否触发预警: level ? '是' : '否',
    记录状态: '已采集',
    辖区乡镇: custody.所属乡镇,
    待办归属: '乡镇',
    命中等级: level,
    登记人: session.operator,
  }
  saveRows(RAIN_KEY, [...rows, record])
  const levelHint = level ? `，自动定级「${level}」（就高取值，待人工复核确认）` : ''
  return { ok: true, message: `雨量记录 ${record['记录编号']} 已登记${levelHint}` }
}

export function submitRainReview(id: number, session: SessionContext): ActionResult {
  const denied = assertTownship(session)
  if (denied) {
    return denied
  }
  const found = findRecord(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const row = found.rows[found.index]
  const rejected = assertJurisdiction(row, session)
  if (rejected) {
    return rejected
  }
  if (String(row.status) !== '已采集') {
    return { ok: false, message: `只有「已采集」的记录能提交审核，当前状态「${row.status}」` }
  }
  const handover = isHandoverWithoutCustodian(String(row['站点编号']))
  const updated: EntryRow = {
    ...row,
    status: '待复核',
    记录状态: '待复核',
    待办归属: '区县',
    提交人: session.operator,
    提交时间: now(),
    ...(handover ? { 转办原因: '站点交接中无负责人' } : {}),
  }
  const next = [...found.rows]
  next[found.index] = updated
  saveRows(RAIN_KEY, next)
  if (handover) {
    return { ok: true, message: `站点交接期间无负责人，记录 ${row['记录编号']} 未予放行，已转交区县待办` }
  }
  return { ok: true, message: `雨量记录 ${row['记录编号']} 已提交审核，待区县复核` }
}

/** 复核通过后若记录达预警值，在预警发布模块生成「待发布」通知；按记录编号幂等，重复复核不重复生成。 */
function ensureAlarmFor(record: EntryRow): boolean {
  const alarms = listRows(ALARM_KEY)
  const code = String(record['记录编号'])
  const exists = alarms.some((alarm) => String(alarm['触发条件'] ?? '').includes(code))
  if (exists) {
    return false
  }
  const notice: EntryRow = {
    id: nextId(alarms),
    status: '待发布',
    pending: true,
    abnormal: false,
    通知编号: nextCode(alarms, '通知编号', 'ALAR'),
    隐患点编号: String(record['站点编号']),
    预警等级: String(record['命中等级'] || '注意级'),
    触发条件: `雨量记录${code} 时段雨量${record['时段雨量']}mm 超${record['命中等级']}阈值`,
    发布时间: '',
    接收单位: `${record['辖区乡镇']}政府`,
    发布人: '系统生成',
    通知状态: '待发布',
  }
  saveRows(ALARM_KEY, [...alarms, notice])
  return true
}

export function reviewRainRecord(id: number, decision: '通过' | '退回', session: SessionContext): ActionResult {
  if (session.role !== 'county') {
    return { ok: false, message: '只有区县复核员能复核雨量记录，乡镇站员无复核权限' }
  }
  const found = findRecord(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const row = found.rows[found.index]
  const status = String(row.status)
  if (status !== '待复核') {
    // 同一审核结果重复提交只保留一次：已复核过的记录再次提交相同结果，直接忽略。
    const lastDecision = String(row['复核结果'] ?? '')
    if (lastDecision === decision) {
      return { ok: true, message: `记录 ${row['记录编号']} 已复核${decision}，重复提交已忽略，结果只保留一次` }
    }
    return { ok: false, message: `记录 ${row['记录编号']} 已复核${lastDecision || '完毕'}，当前状态「${status}」，不能再复核${decision}` }
  }
  const hit = String(row['是否触发预警']) === '是'
  const reached = hit && decision === '通过'
  const updated: EntryRow = {
    ...row,
    status: decision === '通过' ? (reached ? '达预警值' : '已审核') : '已采集',
    pending: decision !== '通过',
    记录状态: decision === '通过' ? (reached ? '达预警值' : '已审核') : '已采集',
    待办归属: decision === '通过' ? '' : '乡镇',
    复核人: session.operator,
    复核时间: now(),
    复核结果: decision,
  }
  const next = [...found.rows]
  next[found.index] = updated
  saveRows(RAIN_KEY, next)
  if (decision === '退回') {
    return { ok: true, message: `记录 ${row['记录编号']} 已退回${row['辖区乡镇']}重新填报` }
  }
  if (reached) {
    const created = ensureAlarmFor(updated)
    const suffix = created
      ? '，预警发布页已生成待发布通知'
      : '，待发布通知已存在，不重复生成'
    return { ok: true, message: `记录 ${row['记录编号']} 复核通过，自动定级「${row['命中等级']}」达预警值${suffix}` }
  }
  return { ok: true, message: `记录 ${row['记录编号']} 复核通过，状态转为「已审核」` }
}

export function markRainAbnormal(id: number, session: SessionContext): ActionResult {
  const denied = assertTownship(session)
  if (denied) {
    return denied
  }
  const found = findRecord(id)
  if (!found) {
    return { ok: false, message: `没有找到编号为 ${id} 的雨量记录` }
  }
  const row = found.rows[found.index]
  const rejected = assertJurisdiction(row, session)
  if (rejected) {
    return rejected
  }
  if (String(row.status) !== '已采集') {
    return { ok: false, message: `只有「已采集」的记录能标记异常，当前状态「${row.status}」` }
  }
  const next = [...found.rows]
  next[found.index] = { ...row, status: '异常值', 记录状态: '异常值', pending: false, abnormal: true, 待办归属: '' }
  saveRows(RAIN_KEY, next)
  return { ok: true, message: `雨量记录 ${row['记录编号']} 已标记为异常值` }
}

/** 区县待办：所有待复核记录都归区县处理；交接转办的排在前面并带标记。 */
export function countyTodos(): EntryRow[] {
  return listRows(RAIN_KEY)
    .filter((row) => String(row.status) === '待复核' && String(row['待办归属']) === '区县')
    .sort((a, b) => Number(Boolean(b['转办原因'])) - Number(Boolean(a['转办原因'])))
}
