import { defineStore } from 'pinia'

import type { OperatorContext, OperatorRole } from '@/data/types'

export const useSessionStore = defineStore('session', {
  state: () => ({
    role: 'township' as OperatorRole,
    township: '清泉镇',
    operator: '清泉镇站员',
    shiftLabel: '白班 08:00-20:00',
    scope: '地质灾害隐患点监测防治管理系统',
  }),
  getters: {
    canOperate: (state) => state.operator.length > 0,
    isCounty: (state) => state.role === 'county',
    context: (state): OperatorContext => ({
      role: state.role,
      township: state.township,
      operator: state.operator,
    }),
  },
  actions: {
    setShift(label: string) {
      this.shiftLabel = label
    },
    setRole(role: OperatorRole, township?: string) {
      this.role = role
      if (township) {
        this.township = township
      }
      this.operator = role === 'county' ? '区县复核员' : `${this.township}站员`
    },
  },
})
