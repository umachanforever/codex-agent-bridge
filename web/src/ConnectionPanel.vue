<script setup lang="ts">
import { onMounted, ref } from "vue";
import { NButton, NSelect, NAlert } from "naive-ui";
import { api, type Overview } from "./api";

/** Displays authoritative listener details without exposing any credentials. */
const props = defineProps<{ overview: Overview }>();
const notice = ref("");
const models = ref<string[]>([]),
  selected = ref<string | null>(null),
  loading = ref(false),
  error = ref("");
/** Reads all visible models from the current authenticated app-server catalog. */
async function loadModels() {
  loading.value = true;
  error.value = "";
  try {
    models.value = (await api<{ models: string[] }>("models")).models;
    if (!selected.value || !models.value.includes(selected.value)) {
      selected.value = models.value.includes(props.overview.settings.model)
        ? props.overview.settings.model
        : (models.value[0] ?? null);
    }
  } catch (cause) {
    models.value = [];
    selected.value = null;
    error.value = (cause as Error).message;
  } finally {
    loading.value = false;
  }
}
onMounted(loadModels);
/** Clipboard failure leaves the read-only value available for manual selection. */
async function copy(value: string, label: string) {
  try {
    await navigator.clipboard.writeText(value);
    notice.value = `${label} 已复制`;
  } catch {
    notice.value = "无法访问剪贴板，请选中上方内容手动复制。";
  }
}
</script>

<template>
  <section class="panel settings connection-panel" aria-label="客户端接入信息">
    <h2>客户端接入</h2>
    <p>在 WorkBuddy、AstrBot 等客户端选择 OpenAI 兼容接口。</p>
    <label>Base URL</label>
    <div class="connection-row">
      <code class="connection-address">{{ overview.apiBase }}</code>
      <n-button @click="copy(overview.apiBase, 'Base URL')">复制地址</n-button>
    </div>
    <label>可用模型</label>
    <n-alert v-if="error" type="warning">{{ error }}</n-alert>
    <div class="connection-row">
      <n-select
        v-model:value="selected"
        filterable
        :loading="loading"
        :options="models.map((model) => ({ label: model, value: model }))"
        placeholder="选择可用模型"
        aria-label="可用模型"
      />
      <n-button
        :disabled="!selected"
        @click="selected && copy(selected, '模型名称')"
        >复制模型</n-button
      >
    </div>
    <p>
      此处选择用于复制到客户端；服务默认模型在下方「运行参数」中设置。<n-button
        text
        :loading="loading"
        @click="loadModels"
        >刷新模型列表</n-button
      >
    </p>
    <p>
      API Key：在「API keys」页面创建或查看客户端密钥，新密钥以 sk-
      开头。不要填写管理口令或 Codex 登录凭据。
    </p>
    <p>
      地址已包含 /v1，不需要再追加
      /chat/completions。本地址适用于与桥接同机的客户端；Docker、其他设备或反向代理部署请使用实际发布地址。
    </p>
    <p role="status" aria-live="polite">{{ notice }}</p>
  </section>
</template>
