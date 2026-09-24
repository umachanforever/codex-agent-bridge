<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { Chart, registerables } from "chart.js";
import { NButton, NSelect, NAlert } from "naive-ui";
import { api, number, type Key, type Report, type Overview } from "./api";
import { tokens, dollars } from "./format";
import { isDark } from "./theme";

/** Charts use measured token totals; missing counters remain null. */
Chart.register(...registerables);
const props = defineProps<{ overview?: Overview; detailed: boolean }>();
const emit = defineEmits<{ refresh: []; details: [] }>();
const report = ref<Report>(),
  keys = ref<Key[]>([]),
  models = ref<string[]>([]),
  days = ref(7),
  keyId = ref<string | null>(null),
  model = ref<string | null>(null),
  offset = ref(0),
  busy = ref(false),
  error = ref(""),
  canvas = ref<HTMLCanvasElement>();
let chart: Chart | undefined;
/** Late filter responses must never overwrite a more recent query. */
let loadVersion = 0;
async function load(reset = true) {
  const version = ++loadVersion;
  busy.value = true;
  error.value = "";
  if (reset) offset.value = 0;
  try {
    const query = new URLSearchParams({
      since: String(Date.now() - days.value * 86400000),
      offset: String(offset.value),
    });
    if (keyId.value) query.set("keyId", keyId.value);
    if (model.value) query.set("model", model.value);
    const [result, loadedKeys, loadedModels] = await Promise.all([
      api<Report>(`usage?${query}`),
      props.detailed ? api<Key[]>("keys") : Promise.resolve([]),
      props.detailed
        ? api<{ models: string[] }>("usage/models")
        : Promise.resolve({ models: [] }),
    ]);
    if (version !== loadVersion) return;
    report.value = result;
    keys.value = loadedKeys;
    models.value = loadedModels.models;
    emit("refresh");
    await nextTick();
    draw();
  } catch (e) {
    if (version === loadVersion) error.value = (e as Error).message;
  } finally {
    if (version === loadVersion) busy.value = false;
  }
}
function draw() {
  chart?.destroy();
  if (!canvas.value || !report.value?.trend.length) return;
  chart = new Chart(canvas.value, {
    type: "bar",
    data: {
      labels: report.value.trend.map((v) => v.day),
      datasets: [
        {
          label: "输入 token",
          data: report.value.trend.map((v) => v.input),
          backgroundColor: isDark.value ? "#63d5bf" : "#087f70",
          borderRadius: 3,
        },
        {
          label: "输出 token",
          data: report.value.trend.map((v) => v.output),
          backgroundColor: isDark.value ? "#398d80" : "#9ed8cc",
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      color: isDark.value ? "#a7b7c1" : "#6b7b84",
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (context) =>
              `${context.dataset.label}: ${tokens(context.parsed.y)}`,
          },
        },
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: { color: isDark.value ? "#a7b7c1" : "#6b7b84" },
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Token（M = 百万）" },
          ticks: {
            color: isDark.value ? "#a7b7c1" : "#6b7b84",
            callback: (value) => tokens(Number(value)),
          },
          grid: { color: isDark.value ? "#30414c" : "#e3e9ed" },
        },
      },
    },
  });
}
async function paginate(direction: number) {
  offset.value = Math.max(0, offset.value + direction * 50);
  await load(false);
}
watch(
  () => props.detailed,
  () => load(),
);
onMounted(() => load());
watch(isDark, draw);
onBeforeUnmount(() => {
  loadVersion++;
  chart?.destroy();
});
</script>
<template>
  <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert>
  <form class="toolbar filters" @submit.prevent="load()">
    <n-select
      v-model:value="days"
      :options="[
        { label: '最近 24 小时', value: 1 },
        { label: '最近 7 天', value: 7 },
        { label: '最近 30 天', value: 30 },
        { label: '最近 90 天', value: 90 },
      ]"
      aria-label="日期范围"
      @update:value="!detailed && load()"
    /><n-select
      v-if="detailed"
      v-model:value="keyId"
      clearable
      placeholder="全部 API keys"
      :options="[
        { label: '原有环境密钥 (legacy)', value: 'legacy' },
        ...keys.map((k) => ({ label: k.name, value: k.id })),
      ]"
      aria-label="按密钥筛选"
    /><n-select
      v-if="detailed"
      v-model:value="model"
      clearable
      filterable
      placeholder="全部模型"
      :options="models.map((name) => ({ label: name, value: name }))"
      aria-label="按模型筛选"
    /><n-button :loading="busy" attr-type="submit">{{
      detailed ? "查询" : "刷新数据"
    }}</n-button>
    <n-button v-if="!detailed" quaternary @click="emit('details')"
      >查看请求明细</n-button
    >
  </form>
  <div class="metrics" v-if="report && !detailed">
    <div>
      <span>请求次数</span><strong>{{ number(report.summary.requests) }}</strong
      ><small>{{
        report.summary.requests
          ? (
              ((report.summary.successful ?? 0) / report.summary.requests) *
              100
            ).toFixed(1) + "% 成功率"
          : "暂无请求"
      }}</small>
    </div>
    <div>
      <span>已知 token 用量</span
      ><strong>{{ tokens(report.summary.total) }}</strong
      ><small
        >{{ report.summary.measured }} /
        {{ report.summary.requests }} 次请求有计数</small
      >
    </div>
    <div>
      <span>输入 / 输出 token</span
      ><strong class="smaller"
        >{{ tokens(report.summary.input) }} <i>/</i>
        {{ tokens(report.summary.output) }}</strong
      ><small
        >缓存输入 {{ tokens(report.summary.cached) }} · 推理输出
        {{ tokens(report.summary.reasoning) }}</small
      >
    </div>
    <div>
      <span>预计花费</span>
      <strong class="smaller">{{ dollars(report.summary.costUsd) }}</strong>
      <small v-if="report.summary.priced < report.summary.requests"
        >仅含 {{ report.summary.priced }} 次可估算请求</small
      >
      <small v-else>USD · 按模型单价估算</small>
    </div>
    <div>
      <span>当前并发</span><strong>{{ number(overview?.active) }}</strong
      ><small>{{
        overview?.ready ? "app-server 已就绪" : "app-server 未就绪"
      }}</small>
    </div>
  </div>
  <section class="panel" v-if="report && detailed">
    <div class="section-heading">
      <div>
        <h2>标准短上下文参考成本</h2>
        <strong>{{ dollars(report.summary.costUsd) }}</strong>
        <p>
          {{ report.summary.priced }} /
          {{ report.summary.requests }}
          次请求可估算；仅合计有价格且输入、缓存、输出计数完整的记录。
        </p>
        <p>
          按当前配置单价重新估值，并非实际账单。不含长上下文加价、Fast、缓存写入、工具费及税费。1
          M = 1,000,000 Token。
        </p>
        <p>
          <a
            :href="report.pricing.source"
            target="_blank"
            rel="noopener noreferrer"
            >OpenAI 官方价格</a
          >
          ·
          {{
            report.pricing.custom
              ? "管理员保存价格 · " + report.pricing.updatedAt
              : "内置快照 · " + report.pricing.checkedAt
          }}
          · USD
        </p>
      </div>
    </div>
  </section>
  <section class="panel" v-if="!detailed">
    <div class="section-heading">
      <div>
        <h2>Token 趋势</h2>
        <p>UTC 按日聚合 · 缓存计入输入、推理计入输出，不重复累加</p>
      </div>
    </div>
    <div v-if="report?.trend.length" class="chart">
      <canvas
        ref="canvas"
        role="img"
        aria-label="每日输入与输出 token 趋势图"
      ></canvas>
    </div>
    <div v-else class="empty chart-empty">
      尚无用量记录
      <p>通过桥接完成请求后，这里会显示真实 token 计数。历史请求不会被补算。</p>
    </div>
  </section>
  <section class="panel" v-if="detailed">
    <div class="section-heading">
      <div>
        <h2>请求记录</h2>
        <p v-if="report">
          查询结果：{{ number(report.summary.requests) }} 次请求 · 已知用量
          {{ tokens(report.summary.total) }} token ·
          {{ number(report.summary.measured) }} 次有计数
        </p>
      </div>
      <span>不保存提示词、回复与工具参数</span>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>时间 / 请求 ID</th>
            <th>模型 / 客户端</th>
            <th>状态</th>
            <th>Token（M）</th>
            <th>参考成本（USD）</th>
            <th>耗时</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in report?.rows" :key="row.id">
            <td>
              {{ new Date(row.started).toLocaleString()
              }}<small
                ><code :title="row.id">{{ row.id.slice(0, 12) }}</code></small
              >
            </td>
            <td>
              {{ row.model
              }}<small>{{
                keys.find((k) => k.id === row.key_id)?.name ?? row.key_id
              }}</small>
            </td>
            <td>
              <span
                :class="
                  row.status >= 400 || row.error ? 'error-text' : 'success-text'
                "
                >{{ row.status }}</span
              ><small>{{ row.error }}</small>
            </td>
            <td>
              {{ tokens(row.total)
              }}<small
                >输入 {{ tokens(row.input) }} / 输出
                {{ tokens(row.output) }}</small
              >
            </td>
            <td>{{ dollars(row.costUsd) }}</td>
            <td>{{ (row.duration / 1000).toFixed(2) }} s</td>
          </tr>
          <tr v-if="!report?.rows.length">
            <td colspan="6" class="empty">当前筛选条件下没有请求。</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <n-button
        size="small"
        :disabled="offset === 0 || busy"
        @click="paginate(-1)"
        >上一页</n-button
      ><span>第 {{ offset / 50 + 1 }} 页</span
      ><n-button
        size="small"
        :disabled="!report || offset + 50 >= report.summary.requests || busy"
        @click="paginate(1)"
        >下一页</n-button
      >
    </div>
  </section>
</template>
