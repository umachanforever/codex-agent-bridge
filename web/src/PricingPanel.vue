<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { NAlert, NButton, NCheckbox, NInputNumber } from "naive-ui";
import { api } from "./api";

/** Editable draft stays separate from persisted prices and model candidates. */
type Rate = [number, number, number];
interface Prices {
  rates: Record<string, Rate>;
  revision: string;
  custom: boolean;
  updatedAt: string | null;
  checkedAt: string;
  source: string;
}
interface Candidate {
  rates: Record<string, Rate>;
  evidence: Record<string, string>;
  source: string;
  fetchedAt: string;
  model: string;
}
const current = ref<Prices>();
/** The live catalog limits presentation, never deletes saved unavailable models. */
const available = ref<string[]>([]);
const rows = ref<
  {
    model: string;
    input: number | null;
    cached: number | null;
    output: number | null;
  }[]
>([]);
const candidate = ref<Candidate>();
const selected = ref<string[]>([]);
const busy = ref(false),
  querying = ref(false),
  confirmed = ref(false);
const error = ref(""),
  message = ref("");
const differences = computed(() =>
  Object.entries(candidate.value?.rates ?? {})
    .filter(([model]) => available.value.includes(model))
    .map(([model, rate]) => {
      const old = rows.value.find((row) => row.model === model);
      return {
        model,
        rate,
        old: old ? [old.input, old.cached, old.output].join(" / ") : "未设置",
      };
    }),
);
/** Reload only on explicit action so in-progress edits are not silently lost. */
async function load() {
  busy.value = true;
  error.value = "";
  current.value = undefined;
  rows.value = [];
  available.value = [];
  try {
    const [prices, catalog] = await Promise.all([
      api<Prices>("pricing"),
      api<{ models: string[] }>("models"),
    ]);
    current.value = prices;
    available.value = [...new Set(catalog.models)];
    rows.value = available.value.map((model) => ({
      model,
      input: prices.rates[model]?.[0] ?? null,
      cached: prices.rates[model]?.[1] ?? null,
      output: prices.rates[model]?.[2] ?? null,
    }));
    candidate.value = undefined;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
/** Saves the complete draft with a revision check; missing numeric values fail closed. */
async function save() {
  error.value = "";
  message.value = "";
  const rates: Record<string, Rate> = Object.assign(
    Object.create(null),
    current.value?.rates,
  );
  for (const row of rows.value) {
    const values = [row.input, row.cached, row.output];
    if (values.every((value) => value == null)) {
      delete rates[row.model];
      continue;
    }
    if (
      !row.model ||
      values.some(
        (value) => value == null || !Number.isFinite(value) || value < 0,
      )
    ) {
      error.value = "请填写完整的非负价格；未知价格请清空整行，不要填写 0。";
      return;
    }
    rates[row.model] = values as Rate;
  }
  busy.value = true;
  try {
    current.value = await api<Prices>("pricing", {
      rates,
      revision: current.value?.revision,
    });
    message.value =
      "价格已保存，重新查询用量时生效（历史记录也按新价格估值）。";
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
/** One user-confirmed model call obtains candidates, never writes configuration. */
async function discover() {
  querying.value = true;
  error.value = "";
  message.value = "";
  candidate.value = undefined;
  try {
    candidate.value = await api<Candidate>("pricing/discover", {
      confirm: confirmed.value,
    });
    selected.value = [];
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    querying.value = false;
  }
}
/** Only explicitly selected candidates replace draft rows; saving remains separate. */
function apply() {
  for (const model of selected.value) {
    const rate = candidate.value?.rates[model];
    if (!rate || !available.value.includes(model)) continue;
    const row = { model, input: rate[0], cached: rate[1], output: rate[2] };
    const index = rows.value.findIndex((value) => value.model === model);
    if (index >= 0) rows.value[index] = row;
    else rows.value.push(row);
  }
  selected.value = [];
  message.value = "已填入编辑表，尚未保存；请核对后点击保存价格。";
}
onMounted(load);
</script>
<template>
  <section class="panel">
    <h2>模型价格</h2>
    <p>仅显示当前可用模型 · USD / 1M Token · 参考估值，非实际账单。</p>
    <p v-if="current">
      {{ current.custom ? "当前为管理员保存价格" : "当前为内置公开价格快照" }} ·
      {{ current.updatedAt ?? current.checkedAt }}
    </p>
    <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert>
    <n-alert v-if="message" type="success" class="notice">{{
      message
    }}</n-alert>
    <div v-if="current" class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>模型 ID</th>
            <th>输入 $/M</th>
            <th>缓存 $/M</th>
            <th>输出 $/M</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.model">
            <td>
              {{ row.model }}
            </td>
            <td>
              <n-input-number
                v-model:value="row.input"
                :min="0"
                :max="1000000"
                :disabled="busy || querying"
                aria-label="输入单价"
              />
            </td>
            <td>
              <n-input-number
                v-model:value="row.cached"
                :min="0"
                :max="1000000"
                :disabled="busy || querying"
                aria-label="缓存输入单价"
              />
            </td>
            <td>
              <n-input-number
                v-model:value="row.output"
                :min="0"
                :max="1000000"
                :disabled="busy || querying"
                aria-label="输出单价"
              />
            </td>
            <td>
              <n-button
                :disabled="busy || querying"
                @click="row.input = row.cached = row.output = null"
                >清空</n-button
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-if="current && !rows.length">当前没有可用模型。</p>
    <div class="toolbar">
      <n-button
        type="primary"
        :loading="busy"
        :disabled="!current || querying"
        @click="save"
        >保存价格</n-button
      >
      <n-button :disabled="busy || querying" @click="load"
        >放弃编辑并重新加载</n-button
      >
    </div>
    <h3>获取官方最新价格</h3>
    <p>
      服务读取固定 OpenAI 官方价格页，再由 gpt-6-luna
      提取候选值。模型可能识别错误，请对照来源核实；不会自动覆盖手动价格。
    </p>
    <n-checkbox v-model:checked="confirmed" :disabled="querying"
      >我确认本次查询会调用模型并消耗用量</n-checkbox
    >
    <n-button
      :disabled="!confirmed || !current || busy"
      :loading="querying"
      @click="discover"
      >获取官方最新价格</n-button
    >
    <div v-if="candidate">
      <p>
        <a :href="candidate.source" target="_blank" rel="noopener noreferrer"
          >官方来源</a
        >
        · {{ candidate.fetchedAt }} · {{ candidate.model }}
      </p>
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>应用</th>
              <th>模型</th>
              <th>编辑表价格</th>
              <th>候选价格（输入 / 缓存 / 输出）</th>
              <th>原文依据</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in differences" :key="item.model">
              <td>
                <n-checkbox
                  :checked="selected.includes(item.model)"
                  @update:checked="
                    (value) =>
                      (selected = value
                        ? [...selected, item.model]
                        : selected.filter((id) => id !== item.model))
                  "
                />
              </td>
              <td>{{ item.model }}</td>
              <td>{{ item.old }}</td>
              <td>{{ item.rate.join(" / ") }}</td>
              <td>
                <details>
                  <summary>查看原文</summary>
                  {{ candidate.evidence[item.model] }}
                </details>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <n-button :disabled="!selected.length || busy" @click="apply"
        >将所选候选填入编辑表（不保存）</n-button
      >
    </div>
  </section>
</template>
