<template>
  <section class="page" data-module="rain_gauge">
    <header class="page-head">
      <div>
        <h2>雨量监测管理</h2>
        <p class="page-desc">维护雨量记录，围绕记录编号、站点编号、观测时段、时段雨量做登记、筛选与状态流转。</p>
        <p class="page-desc">
          当前身份：{{ store.roleLabel }}；乡镇站员登记本辖区记录并提交审核，区县复核员只读并负责复核，跨辖区操作一律拒绝。
        </p>
      </div>
      <div class="page-actions">
        <button v-if="store.isTownship" class="btn primary" type="button" @click="showCreate = !showCreate">
          登记雨量记录
        </button>
        <button class="btn" type="button" @click="exportRows">导出雨量监测清单</button>
      </div>
    </header>

    <div v-if="store.isCounty" class="todo-panel">
      <strong>区县待办：{{ todos.length }} 条</strong>
      <span v-if="handoverCount">（其中站点交接转办 {{ handoverCount }} 条，需优先处理）</span>
      <span v-if="!todos.length">暂无待复核记录</span>
    </div>

    <form v-if="store.isTownship && showCreate" class="create-panel" @submit.prevent="submitCreate">
      <label class="filter-item">
        <span>站点编号</span>
        <select v-model="form.站点编号">
          <option v-for="station in stations" :key="station.站点编号" :value="station.站点编号">
            {{ station.站点编号 }} · {{ station.所属乡镇 }}
            {{ station.代管状态 === '交接中' ? '（交接中）' : '' }}
          </option>
        </select>
      </label>
      <label class="filter-item">
        <span>观测时段</span>
        <input v-model="form.观测时段" placeholder="如 2026-10-05 08:00-14:00" />
      </label>
      <label class="filter-item">
        <span>时段雨量(mm)</span>
        <input v-model="form.时段雨量" placeholder="数字" />
      </label>
      <label class="filter-item">
        <span>日累计雨量(mm)</span>
        <input v-model="form.日累计雨量" placeholder="数字" />
      </label>
      <label class="filter-item">
        <span>小时最大雨强(mm/h)</span>
        <input v-model="form.小时最大雨强" placeholder="数字" />
      </label>
      <button class="btn primary" type="submit">保存登记</button>
    </form>

    <div class="stat-row">
      <article v-for="item in statCards" :key="item.label" class="stat-card">
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
          <th>辖区乡镇</th>
          <th>命中等级</th>
          <th>待办归属</th>
          <th>阈值关联</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row['辖区乡镇'] || '—' }}</td>
          <td>{{ row['命中等级'] || '—' }}</td>
          <td>
            {{ row['待办归属'] || '—' }}
            <span v-if="row['转办原因']" class="badge warn">交接转办</span>
          </td>
          <td>
            <RouterLink class="link" :to="`/threshold?station=${row['站点编号']}`">关联阈值</RouterLink>
          </td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <template v-if="store.isTownship">
              <button class="link" type="button" @click="submitReview(row)">提交审核</button>
              <button class="link" type="button" @click="markAbnormal(row)">标记异常</button>
            </template>
            <template v-else>
              <button class="link" type="button" @click="review(row, '通过')">复核通过</button>
              <button class="link" type="button" @click="review(row, '退回')">复核退回</button>
            </template>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 6" class="empty-state">暂无雨量监测数据，可先登记雨量记录</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条雨量监测记录</span>
      <span v-if="message" :class="messageOk ? 'ok-text' : 'error-text'">{{ message }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'

import { downloadEntries, listEntries, moduleMeta } from '@/api/local-service'
import {
  countyTodos,
  markRainAbnormal,
  registerRainRecord,
  reviewRainRecord,
  submitRainReview,
  type SessionContext,
} from '@/api/rain-gauge-service'
import { STATION_CUSTODY } from '@/data/station-custody'
import type { EntryRow } from '@/data/types'
import { useSessionStore } from '@/stores/session'

const meta = moduleMeta('rain_gauge')
const store = useSessionStore()
const columns = meta.fields
const statuses = meta.statuses
const stations = STATION_CUSTODY

const rows = ref<EntryRow[]>([])
const total = ref(0)
const message = ref('')
const messageOk = ref(false)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const showCreate = ref(false)
const form = reactive({
  站点编号: stations[0]?.站点编号 ?? '',
  观测时段: '',
  时段雨量: '',
  日累计雨量: '',
  小时最大雨强: '',
})

const todos = ref<EntryRow[]>([])
const handoverCount = computed(() => todos.value.filter((row) => row['转办原因']).length)

const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

const statCards = computed(() => [
  { label: '雨量站点数', value: stations.length },
  { label: '达预警值站次', value: rows.value.filter((row) => String(row.status) === '达预警值').length },
  {
    label: '累计降雨量',
    value: rows.value.reduce((sum, row) => sum + (Number(row['日累计雨量']) || 0), 0).toFixed(1),
  },
])

function session(): SessionContext {
  return { operator: store.operator, role: store.role, township: store.township }
}

function apply(result: { ok: boolean; message: string }) {
  message.value = result.message
  messageOk.value = result.ok
  reload()
}

function submitCreate() {
  apply(registerRainRecord({ ...form }, session()))
}

function submitReview(row: EntryRow) {
  apply(submitRainReview(Number(row.id), session()))
}

function markAbnormal(row: EntryRow) {
  apply(markRainAbnormal(Number(row.id), session()))
}

function review(row: EntryRow, decision: '通过' | '退回') {
  apply(reviewRainRecord(Number(row.id), decision, session()))
}

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function reload() {
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
    todos.value = countyTodos()
  } catch (error) {
    messageOk.value = false
    message.value = error instanceof Error ? error.message : '雨量监测列表读取失败'
  }
}

onMounted(reload)
</script>
