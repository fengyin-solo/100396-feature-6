// 站点代管权登记册：雨量站点按站点编号登记所属乡镇与负责人。
// 乡镇站员只能操作本辖区站点；交接中且无负责人的站点不放行，一律转交区县待办。
export type StationCustody = {
  站点编号: string
  所属乡镇: string
  所属区县: string
  负责人: string
  代管状态: '在岗' | '交接中'
}

export const COUNTY_NAME = '临江县'

export const STATION_CUSTODY: StationCustody[] = [
  { 站点编号: 'RAIN-0001', 所属乡镇: '青云镇', 所属区县: COUNTY_NAME, 负责人: '张青山', 代管状态: '在岗' },
  { 站点编号: 'RAIN-0002', 所属乡镇: '青云镇', 所属区县: COUNTY_NAME, 负责人: '', 代管状态: '交接中' },
  { 站点编号: 'RAIN-0003', 所属乡镇: '白水镇', 所属区县: COUNTY_NAME, 负责人: '李映雪', 代管状态: '在岗' },
  { 站点编号: 'RAIN-0004', 所属乡镇: '龙冈乡', 所属区县: COUNTY_NAME, 负责人: '王守岭', 代管状态: '在岗' },
]

export function custodyOf(stationCode: string): StationCustody | undefined {
  return STATION_CUSTODY.find((item) => item.站点编号 === stationCode)
}

/** 交接期间无负责人：这类站点的记录不放行，转交区县待办。 */
export function isHandoverWithoutCustodian(stationCode: string): boolean {
  const custody = custodyOf(stationCode)
  return !!custody && custody.代管状态 === '交接中' && custody.负责人.trim() === ''
}
