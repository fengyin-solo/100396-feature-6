import { defineStore } from 'pinia'

import { COUNTY_NAME } from '@/data/station-custody'

// 角色：乡镇站员在本辖区登记并提交审核；区县复核员只读并负责复核。
export type SessionRole = 'township' | 'county'

export const useSessionStore = defineStore('session', {
  state: () => ({
    operator: '张青山',
    role: 'township' as SessionRole,
    township: '青云镇',
    county: COUNTY_NAME,
    shiftLabel: '白班 08:00-20:00',
    scope: '地质灾害隐患点监测防治管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isTownship: (state) => state.role === 'township',
    isCounty: (state) => state.role === 'county',
    roleLabel(state): string {
      return state.role === 'county'
        ? `区县复核员 · ${state.county}`
        : `乡镇站员 · ${state.township}`
    },
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: SessionRole, township?: string) {
      this.role = role
      if (role === 'county') {
        this.operator = '区县复核员'
        return
      }
      if (township) {
        this.township = township
      }
      this.operator = `${this.township}站员`
    },
  },
})
