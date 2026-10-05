// 冒烟脚本：验证雨量代管权与审核流规则，esbuild 打包后用 node 跑。
import {
  listEntries,
  listRowActions,
  registerRainEntry,
  resetModule,
  runAction,
} from '@/api/local-service'
import { listRows } from '@/data/local-store'
import type { OperatorContext } from '@/data/types'

const qs: OperatorContext = { role: 'township', township: '清泉镇', operator: '清泉镇站员' }
const yt: OperatorContext = { role: 'township', township: '云台镇', operator: '云台镇站员' }
const county: OperatorContext = { role: 'county', township: '', operator: '区县复核员' }

let failures = 0
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`ok  - ${name}`)
  } else {
    failures += 1
    console.log(`FAIL- ${name} ${detail}`)
  }
}

resetModule('rain_gauge')
resetModule('alarm')
resetModule('threshold')

// 1. 登记权限
let r = registerRainEntry({ 站点编号: 'RAIN-0001', 观测时段: '2026-10-05 08:00-12:00', 时段雨量: '32.5', 日累计雨量: '', 小时最大雨强: '' }, qs)
check('乡镇登记本辖区站点', r.ok, r.message)
r = registerRainEntry({ 站点编号: 'RAIN-0003', 观测时段: '2026-10-05 08:00-12:00', 时段雨量: '10', 日累计雨量: '', 小时最大雨强: '' }, qs)
check('跨辖区登记被拒绝', !r.ok && r.message.includes('跨辖区'), r.message)
r = registerRainEntry({ 站点编号: 'RAIN-0001', 观测时段: '2026-10-05 08:00-12:00', 时段雨量: '10', 日累计雨量: '', 小时最大雨强: '' }, county)
check('区县登记被拒绝', !r.ok, r.message)
r = registerRainEntry({ 站点编号: 'RAIN-9999', 观测时段: 'x', 时段雨量: '10', 日累计雨量: '', 小时最大雨强: '' }, qs)
check('未登记代管权站点被拒绝', !r.ok, r.message)

// 2. 提交审核权限与辖区
r = runAction('rain_gauge', 1, '提交审核', qs) // RAIN-0001 归属清泉镇
check('乡镇提交本辖区记录', r.ok, r.message)
r = runAction('rain_gauge', 1, '提交审核', qs)
check('重复提交被状态拦截', !r.ok, r.message)
r = runAction('rain_gauge', 2, '提交审核', qs) // RAIN-0002 归属云台镇
check('跨辖区提交被拒绝', !r.ok && r.message.includes('跨辖区'), r.message)
r = runAction('rain_gauge', 1, '提交审核', county)
check('区县提交审核被拒绝', !r.ok, r.message)

// 3. 交接中站点：转交区县待办而不是放行
const handoverRecord = registerRainEntry({ 站点编号: 'RAIN-0004', 观测时段: '2026-10-05 09:00-10:00', 时段雨量: '130', 日累计雨量: '', 小时最大雨强: '' }, yt)
check('云台镇登记交接中站点', handoverRecord.ok, handoverRecord.message)
const newRow = listRows('rain_gauge').find((row) => row['站点编号'] === 'RAIN-0004' && row.status === '已采集')
r = runAction('rain_gauge', Number(newRow!.id), '提交审核', yt)
check('交接中站点提交后转区县待办', r.ok && r.message.includes('区县待办'), r.message)
const escalated = listRows('rain_gauge').find((row) => Number(row.id) === Number(newRow!.id))
check('待办记录未放行（仍待复核+标记）', escalated!.status === '待复核' && escalated!['区县待办'] === true)

// 4. 复核权限
r = runAction('rain_gauge', 2, '复核通过', qs)
check('乡镇复核被拒绝', !r.ok, r.message)

// 5. 复核通过 → 自动定级（56mm ≥ 警示级50 < 警戒级100）→ 生成待发布通知
const alarmsBefore = listRows('alarm').length
r = runAction('rain_gauge', 2, '复核通过', county)
check('区县复核通过', r.ok, r.message)
const reviewed = listRows('rain_gauge').find((row) => Number(row.id) === 2)!
check('达多级别取最高（56mm→警示级）', reviewed.status === '达预警值' && reviewed['是否触发预警'] === '是')
const alarms = listRows('alarm')
const notice = alarms.find((row) => row['来源记录'] === 'RAIN-0002')
check('生成待发布通知', alarms.length === alarmsBefore + 1 && !!notice && notice.status === '待发布')
check('通知定级为警示级', notice?.['预警等级'] === '警示级', String(notice?.['预警等级']))
check('通知接收单位为原归属乡镇', notice?.['接收单位'] === '云台镇人民政府')

// 6. 同一审核结果重复提交只保留一次
r = runAction('rain_gauge', 2, '复核通过', county)
check('重复复核通过被幂等拦截', !r.ok && r.message.includes('只保留一次'), r.message)
check('通知未重复生成', listRows('alarm').filter((row) => row['来源记录'] === 'RAIN-0002').length === 1)

// 7. 警戒级定级（120mm 达注意/警示/警戒三级 → 取警戒级）
const seed3 = listRows('rain_gauge').find((row) => row['记录编号'] === 'RAIN-0003')!
check('种子记录 RAIN-0003 已为警戒级达预警值', seed3.status === '达预警值')

// 8. 复核驳回 → 退回已采集，可重新提交
r = runAction('rain_gauge', 4, '复核驳回', county) // 交接中站点的待办件
check('区县驳回区县待办件', r.ok, r.message)
check('驳回后退回已采集', listRows('rain_gauge').find((row) => Number(row.id) === 4)!.status === '已采集')
r = runAction('rain_gauge', 4, '复核驳回', county)
check('非待复核状态不能驳回', !r.ok, r.message)

// 9. 标记异常权限
r = runAction('rain_gauge', 1, '标记异常', qs)
check('乡镇标记异常被拒绝', !r.ok, r.message)
r = runAction('rain_gauge', 1, '标记异常', county)
check('区县标记异常', r.ok && listRows('rain_gauge').find((row) => Number(row.id) === 1)!.status === '异常值', r.message)

// 10. 行内动作清单
const row1 = listRows('rain_gauge').find((row) => Number(row.id) === 5)! // 柏树镇历史记录，已审核
check('乡镇对本辖区已采集记录可提交', listRowActions('rain_gauge', { ...row1, status: '已采集', 归属乡镇: '清泉镇' }, qs).join() === '提交审核')
check('乡镇对历史外辖区记录只读', listRowActions('rain_gauge', row1, qs).length === 0)
check('历史记录仍按原归属显示', row1['归属乡镇'] === '柏树镇' && row1['站点编号'] === 'RAIN-0002')
const pendingRow = listRows('rain_gauge').find((row) => row.status === '待复核')!
check('区县对待复核记录可复核', listRowActions('rain_gauge', pendingRow, county).join() === '复核通过,复核驳回,标记异常')
check('区县对非待复核记录只读', listRowActions('rain_gauge', row1, county).length === 0)

// 11. 未达阈值复核通过 → 已审核且不生成通知
registerRainEntry({ 站点编号: 'RAIN-0001', 观测时段: '2026-10-05 13:00-14:00', 时段雨量: '5', 日累计雨量: '', 小时最大雨强: '' }, qs)
const low = listRows('rain_gauge').filter((row) => row['时段雨量'] === 5)[0]
runAction('rain_gauge', Number(low.id), '提交审核', qs)
const before = listRows('alarm').length
r = runAction('rain_gauge', Number(low.id), '复核通过', county)
check('未达阈值复核通过→已审核', r.ok && listRows('rain_gauge').find((row) => Number(row.id) === Number(low.id))!.status === '已审核', r.message)
check('未达阈值不生成通知', listRows('alarm').length === before)

// 12. 交接中站点高雨量：复核通过后照样定级发通知（警戒级）
r = runAction('rain_gauge', Number(newRow!.id), '复核通过', county)
const escalatedNotice = listRows('alarm').find((row) => row['来源记录'] === newRow!['记录编号'])
check('区县待办件复核通过→警戒级通知', r.ok && escalatedNotice?.['预警等级'] === '警戒级', r.message)

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`)
process.exit(failures === 0 ? 0 : 1)
