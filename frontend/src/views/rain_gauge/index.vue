<template>
  <section class="page" data-module="rain_gauge">
    <header class="page-head">
      <div>
        <h2>雨量监测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button v-if="!session.isCounty" class="btn primary" type="button" @click="openCreate">登记雨量记录</button>
        <button class="btn" type="button" @click="exportRows">导出雨量监测清单</button>
      </div>
    </header>

    <p class="role-banner">
      当前身份：{{ roleLabel }}。乡镇站员可登记本辖区记录并提交审核；区县人员只读并负责复核；跨辖区操作一律拒绝。
    </p>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] === '' || row[column] == null ? '—' : row[column] }}</td>
          <td>
            {{ row.status }}
            <span v-if="row.status === '待复核' && row['区县待办']" class="badge">区县待办</span>
          </td>
          <td class="row-actions">
            <button
              v-for="action in rowActions(row)"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
            <span v-if="!rowActions(row).length" class="muted-text">只读</span>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无雨量监测数据，可先登记雨量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条雨量监测记录</span>
      <span v-if="infoMessage" class="info-text">{{ infoMessage }}</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <form class="modal-card" @submit.prevent="submitCreate">
        <h3>登记雨量记录（{{ session.township }}）</h3>
        <label class="form-row">
          <span>站点编号</span>
          <select v-model="createForm.站点编号">
            <option v-for="station in myStations" :key="station.站点编号" :value="station.站点编号">
              {{ station.站点编号 }}（{{ station.负责人 ? `负责人 ${station.负责人}` : '交接中，暂无负责人' }}）
            </option>
          </select>
        </label>
        <label class="form-row">
          <span>观测时段</span>
          <input v-model="createForm.观测时段" placeholder="如 2026-10-05 08:00-12:00" />
        </label>
        <label class="form-row">
          <span>时段雨量（mm）</span>
          <input v-model="createForm.时段雨量" type="number" min="0" step="0.1" placeholder="如 32.5" />
        </label>
        <label class="form-row">
          <span>日累计雨量（mm，可空）</span>
          <input v-model="createForm.日累计雨量" type="number" min="0" step="0.1" />
        </label>
        <label class="form-row">
          <span>小时最大雨强（mm/h，可空）</span>
          <input v-model="createForm.小时最大雨强" type="number" min="0" step="0.1" />
        </label>
        <p v-if="createError" class="error-text">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" type="button" @click="showCreate = false">取消</button>
          <button class="btn primary" type="submit">保存登记</button>
        </div>
      </form>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  listRowActions,
  moduleMeta,
  registerRainEntry,
  runAction as applyAction,
} from '@/api/local-service'
import { stationsOfTownship } from '@/data/stations'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('rain_gauge')
const columns = ["记录编号", "站点编号", "归属乡镇", "观测时段", "时段雨量", "日累计雨量", "小时最大雨强", "是否触发预警", "登记人", "审核备注"]
const statuses = ["已采集", "待复核", "已审核", "达预警值", "异常值"]

const session = useSessionStore()

const rows = ref<EntryRow[]>([])
const snapshot = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const infoMessage = ref('')
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)

const showCreate = ref(false)
const createError = ref('')
const createForm = reactive({ 站点编号: '', 观测时段: '', 时段雨量: '', 日累计雨量: '', 小时最大雨强: '' })

const roleLabel = computed(() =>
  session.isCounty ? '区县人员（只读·负责复核）' : `乡镇站员（${session.township}）`,
)
const myStations = computed(() => stationsOfTownship(session.township))

const stats = computed(() => {
  const all = snapshot.value
  const stations = new Set(all.map((row) => String(row['站点编号'] ?? '')).filter(Boolean)).size
  const warned = all.filter((row) => row.status === '达预警值').length
  const rainfall = all.reduce((sum, row) => sum + (Number(row['时段雨量']) || 0), 0)
  const countyTodo = all.filter((row) => row.status === '待复核' && row['区县待办']).length
  return [
    { label: '雨量站点数', value: stations },
    { label: '达预警值站次', value: warned },
    { label: '累计降雨量(mm)', value: Math.round(rainfall * 10) / 10 },
    { label: '区县待办', value: countyTodo },
  ]
})

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function rowActions(row: EntryRow): string[] {
  return listRowActions(meta.key, row, session.context)
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function openCreate() {
  createError.value = ''
  createForm.站点编号 = myStations.value[0]?.站点编号 ?? ''
  createForm.观测时段 = ''
  createForm.时段雨量 = ''
  createForm.日累计雨量 = ''
  createForm.小时最大雨强 = ''
  showCreate.value = true
}

function submitCreate() {
  createError.value = ''
  const result = registerRainEntry({ ...createForm }, session.context)
  if (!result.ok) {
    createError.value = result.message
    return
  }
  showCreate.value = false
  infoMessage.value = result.message
  reload()
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  infoMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action, session.context)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  infoMessage.value = result.message
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    snapshot.value = listEntries(meta.key).items
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '雨量监测列表读取失败'
  }
}

onMounted(reload)
</script>
