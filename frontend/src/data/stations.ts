// 雨量站点代管权表：站点编号 → 所属辖区（乡镇）→ 当前负责人。
// 负责人为空串表示站点处于交接期、暂无负责人；此时该站点的审核件一律转交区县待办，不放行。
export type StationCustody = {
  站点编号: string
  所属乡镇: string
  负责人: string
  备注: string
}

export const STATION_CUSTODY: StationCustody[] = [
  { 站点编号: 'RAIN-0001', 所属乡镇: '清泉镇', 负责人: '张明', 备注: '' },
  {
    站点编号: 'RAIN-0002',
    所属乡镇: '清泉镇',
    负责人: '张明',
    备注: '2026-08 由柏树镇移交清泉镇代管，移交前的历史记录仍按原归属显示',
  },
  { 站点编号: 'RAIN-0003', 所属乡镇: '云台镇', 负责人: '李芳', 备注: '' },
  { 站点编号: 'RAIN-0004', 所属乡镇: '云台镇', 负责人: '', 备注: '交接中，暂无负责人' },
]

export const TOWNSHIPS: string[] = [...new Set(STATION_CUSTODY.map((item) => item.所属乡镇))]

export function custodyOf(stationCode: string): StationCustody | undefined {
  return STATION_CUSTODY.find((item) => item.站点编号 === stationCode)
}

export function stationsOfTownship(township: string): StationCustody[] {
  return STATION_CUSTODY.filter((item) => item.所属乡镇 === township)
}

/** 站点是否处于交接期（无负责人）。 */
export function inHandover(custody: StationCustody | undefined): boolean {
  return !custody || custody.负责人.trim() === ''
}
