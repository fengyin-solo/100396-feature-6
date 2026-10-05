// 冒烟测试：直接跑领域服务，验证代管权、状态机、幂等与预警联动。
import {
  countyTodos,
  effectiveThresholdFor,
  evaluateRainLevel,
  markRainAbnormal,
  registerRainRecord,
  reviewRainRecord,
  submitRainReview,
} from '@/api/rain-gauge-service'
import { listRows, resetRows } from '@/data/local-store'

const townshipA = { operator: '青云镇站员', role: 'township', township: '青云镇' } as const
const townshipB = { operator: '白水镇站员', role: 'township', township: '白水镇' } as const
const county = { operator: '区县复核员', role: 'county', township: '' } as const

let failed = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`ok  - ${name}`)
  } else {
    failed += 1
    console.log(`FAIL- ${name}`, extra ?? '')
  }
}

resetRows('rain_gauge')
resetRows('alarm')
resetRows('threshold')

// 阈值关联：站点专属优先，其次通用
check('RAIN-0001 用专属阈值', effectiveThresholdFor('RAIN-0001')?.['阈值编号'] === 'THRE-0002')
check('RAIN-0002 回落通用阈值', effectiveThresholdFor('RAIN-0002')?.['阈值编号'] === 'THRE-0001')
check('草稿阈值不生效(RAIN-0003 用通用)', effectiveThresholdFor('RAIN-0003')?.['阈值编号'] === 'THRE-0001')

// 自动定级就高：通用阈值 25/50/80
const t = effectiveThresholdFor('RAIN-0002')
check('85mm 命中警戒级(就高)', evaluateRainLevel(85, t) === '警戒级')
check('68mm 命中警示级', evaluateRainLevel(68, t) === '警示级')
check('10mm 未达级', evaluateRainLevel(10, t) === '')

// 登记：跨辖区拒绝
const cross = registerRainRecord(
  { 站点编号: 'RAIN-0003', 观测时段: '2026-10-05 08:00', 时段雨量: '10', 日累计雨量: '10', 小时最大雨强: '5' },
  townshipA,
)
check('跨辖区登记被拒绝', !cross.ok && cross.message.includes('跨辖区'), cross.message)

// 区县只读：不能登记
const countyRegister = registerRainRecord(
  { 站点编号: 'RAIN-0001', 观测时段: '2026-10-05 08:00', 时段雨量: '10', 日累计雨量: '10', 小时最大雨强: '5' },
  county,
)
check('区县登记被拒绝', !countyRegister.ok, countyRegister.message)

// 本辖区登记成功，自动定级
const reg = registerRainRecord(
  { 站点编号: 'RAIN-0001', 观测时段: '2026-10-05 08:00-14:00', 时段雨量: '75', 日累计雨量: '90', 小时最大雨强: '30' },
  townshipA,
)
check('本辖区登记成功', reg.ok, reg.message)
const created = listRows('rain_gauge').find((r) => r['观测时段'] === '2026-10-05 08:00-14:00')
check('新记录自动定级警戒级(专属阈值70)', created?.['命中等级'] === '警戒级', created?.['命中等级'])
check('新记录归属青云镇', created?.['辖区乡镇'] === '青云镇')

// 提交审核：跨辖区拒绝（用白水镇身份操作青云镇记录）
const crossSubmit = submitRainReview(Number(created!.id), townshipB)
check('跨辖区提交被拒绝', !crossSubmit.ok && crossSubmit.message.includes('跨辖区'), crossSubmit.message)

// 正常提交 → 待复核
const submit = submitRainReview(Number(created!.id), townshipA)
check('本辖区提交成功', submit.ok, submit.message)

// 乡镇不能复核
const townshipReview = reviewRainRecord(Number(created!.id), '通过', townshipA)
check('乡镇复核被拒绝', !townshipReview.ok, townshipReview.message)

// 区县复核通过 → 达预警值 + 生成待发布通知
const before = listRows('alarm').length
const approve = reviewRainRecord(Number(created!.id), '通过', county)
check('区县复核通过', approve.ok, approve.message)
const afterApprove = listRows('rain_gauge').find((r) => Number(r.id) === Number(created!.id))
check('记录转为达预警值', afterApprove?.status === '达预警值', afterApprove?.status)
const alarms = listRows('alarm')
check('生成一条待发布通知', alarms.length === before + 1 && alarms.some((a) => a.status === '待发布' && String(a['触发条件']).includes(String(created!['记录编号']))))

// 同一审核结果重复提交：只保留一次，不重复生成通知
const dup = reviewRainRecord(Number(created!.id), '通过', county)
check('重复提交被幂等忽略', dup.ok && dup.message.includes('只保留一次'), dup.message)
check('通知没有重复生成', listRows('alarm').length === before + 1)

// 不同结果被拒绝
const contradict = reviewRainRecord(Number(created!.id), '退回', county)
check('已通过后不能再退回', !contradict.ok, contradict.message)

// 交接中站点（RAIN-0002 无负责人）：提交不放行，转区县待办
const seed2 = listRows('rain_gauge').find((r) => r['记录编号'] === 'RAIN-0001' && r['站点编号'] === 'RAIN-0001')
const handoverSubmit = submitRainReview(Number(seed2!.id), townshipA)
// 先把它退回已采集再提交：种子记录1是已采集，直接提交
check('种子记录提交成功', handoverSubmit.ok, handoverSubmit.message)
const handoverRecord = listRows('rain_gauge').find((r) => r['记录编号'] === 'RAIN-0002')
check('交接站点记录已在区县待办', countyTodos().some((r) => r['记录编号'] === 'RAIN-0002' && r['转办原因'] === '站点交接中无负责人'))
check('交接转办排在待办最前', countyTodos()[0]?.['记录编号'] === 'RAIN-0002')

// 标记异常：跨辖区拒绝
const crossMark = markRainAbnormal(Number(handoverRecord!.id), townshipB)
check('跨辖区标记异常被拒绝', !crossMark.ok, crossMark.message)

console.log(failed === 0 ? 'ALL PASS' : `${failed} FAILED`)
process.exit(failed === 0 ? 0 : 1)
