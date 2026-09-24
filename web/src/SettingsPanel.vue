<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { NInputNumber, NButton, NAlert, NSelect } from "naive-ui";
import { api, type Overview } from "./api";
import ConnectionPanel from "./ConnectionPanel.vue";
import PricingPanel from "./PricingPanel.vue";

/** Only safe operational values are editable; authentication stays CLI-owned. */
const props = defineProps<{ overview: Overview }>();
const emit = defineEmits<{ saved: [] }>();
const form = reactive({
  model: props.overview.settings.model,
  seconds: props.overview.settings.timeoutMs / 1000,
  maxRequests: props.overview.settings.maxRequests,
});
const error = ref(""),
  saved = ref(false),
  busy = ref(false);
const models = ref<string[]>([]),
  modelsLoading = ref(false),
  modelsError = ref("");
/** The configured value remains visible when it is absent from a refreshed catalog. */
const modelOptions = computed(() =>
  [...new Set([form.model, ...models.value])]
    .filter(Boolean)
    .map((model) => ({ label: model, value: model })),
);
/** Reads the authenticated app-server model catalog for the default-model picker. */
async function loadModels() {
  modelsLoading.value = true;
  modelsError.value = "";
  try {
    models.value = (await api<{ models: string[] }>("models")).models;
  } catch (cause) {
    models.value = [];
    modelsError.value = (cause as Error).message;
  } finally {
    modelsLoading.value = false;
  }
}
onMounted(loadModels);
/** Persists runtime settings for requests started after this update. */
async function save() {
  busy.value = true;
  error.value = "";
  saved.value = false;
  try {
    await api("settings", {
      model: form.model,
      timeoutMs: form.seconds * 1000,
      maxRequests: form.maxRequests,
    });
    saved.value = true;
    emit("saved");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <ConnectionPanel :overview="overview" />
  <PricingPanel />
  <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert
  ><n-alert v-if="saved" type="success" class="notice"
    >已保存，对新请求生效。正在执行的请求不受影响。</n-alert
  >
  <section class="panel settings">
    <h2>运行参数</h2>
    <form @submit.prevent="save">
      <label
        >服务默认模型<n-select
          v-model:value="form.model"
          filterable
          :loading="modelsLoading"
          :options="modelOptions"
          placeholder="选择默认模型"
          aria-label="服务默认模型" /></label
      ><n-alert v-if="modelsError" type="warning" class="notice"
        >{{ modelsError
        }}<n-button text :loading="modelsLoading" @click="loadModels"
          >重试</n-button
        ></n-alert
      ><label
        >请求超时（秒）<n-input-number
          v-model:value="form.seconds"
          :min="1"
          :max="21600"
          :precision="0" /></label
      ><label
        >最大并发（0 表示不设置本地上限）<n-input-number
          v-model:value="form.maxRequests"
          :min="0"
          :max="10000"
          :precision="0" /></label
      ><n-button type="primary" attr-type="submit" :loading="busy"
        >保存设置</n-button
      >
    </form>
  </section>
  <section class="panel settings">
    <h2>认证与部署</h2>
    <dl>
      <dt>Codex 认证模式</dt>
      <dd>
        {{
          overview.authMode === "reuse"
            ? "复用本地认证（不会自动登录）"
            : "独立登录（显式启用）"
        }}
      </dd>
      <dt>认证来源</dt>
      <dd>
        {{
          overview.authMode === "reuse"
            ? overview.authSource
            : "桥接独立认证目录"
        }}
      </dd>
      <dt>记录保留时间</dt>
      <dd>{{ overview.retentionDays }} 天</dd>
    </dl>
    <p>
      认证来源、监听地址和执行权限由启动参数控制，不允许网页修改。复用模式只同步认证文件，不改写桌面
      Codex 的配置。
    </p>
    <p>这里的 token 用量不是订阅剩余额度，也不是实际账单金额。</p>
  </section>
</template>
