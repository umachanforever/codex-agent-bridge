<script setup lang="ts">
import { onMounted, ref } from "vue";
import { NButton, NInput, NModal, NAlert, NTag, NPopconfirm } from "naive-ui";
import { api, type Key } from "./api";

/** Secret material lives only in the transient reveal modal. */
const keys = ref<Key[]>([]),
  name = ref(""),
  error = ref(""),
  busy = ref(false),
  secret = ref(""),
  copied = ref(false),
  action = ref<"reveal" | "rotate">("reveal"),
  target = ref<Key>(),
  token = ref("");
async function load() {
  keys.value = await api<Key[]>("keys");
}
async function run(task: () => Promise<void>) {
  busy.value = true;
  error.value = "";
  try {
    await task();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
async function create() {
  await run(async () => {
    const result = await api<Key & { secret: string }>("keys", {
      name: name.value,
    });
    secret.value = result.secret;
    copied.value = false;
    name.value = "";
    await load();
  });
}
async function enabled(key: Key) {
  await run(async () => {
    await api(`keys/${key.id}/enabled`, { enabled: !key.enabled });
    await load();
  });
}
function confirmReveal(key: Key) {
  target.value = key;
  action.value = "reveal";
  token.value = "";
  secret.value = "";
  copied.value = false;
}
/** Rotates after the visible confirmation without asking for the password again. */
async function rotate(key: Key) {
  await run(async () => {
    const result = await api<{ secret: string }>(`keys/${key.id}/rotate`, {
      confirm: true,
    });
    target.value = key;
    action.value = "rotate";
    secret.value = result.secret;
    copied.value = false;
    await load();
  });
}
async function reveal() {
  await run(async () => {
    const result = await api<{ secret: string }>(
      `keys/${target.value!.id}/reveal`,
      {
        token: token.value,
      },
    );
    token.value = "";
    // Keep the result in this modal: a closing confirmation dialog can cover
    // a second dialog while its exit transition is still running.
    secret.value = result.secret;
    copied.value = false;
    await load();
  });
}
async function copy() {
  try {
    await navigator.clipboard.writeText(secret.value);
    copied.value = true;
  } catch {
    error.value = "剪贴板不可用，请手动选择并复制密钥。";
  }
}
onMounted(() => run(load));
</script>
<template>
  <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert>
  <form class="toolbar" @submit.prevent="create">
    <n-input
      v-model:value="name"
      placeholder="密钥名称，例如 WorkBuddy 或 QQ 机器人"
      :maxlength="80"
      aria-label="密钥名称"
    /><n-button
      type="primary"
      attr-type="submit"
      :loading="busy"
      :disabled="!name.trim()"
      >创建密钥</n-button
    >
  </form>
  <section class="panel">
    <div class="section-heading">
      <h2>调用密钥</h2>
      <span>{{ keys.length }} 个密钥</span>
    </div>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>名称 / 密钥</th>
            <th>状态</th>
            <th>最后使用</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="key in keys" :key="key.id">
            <td>
              <strong>{{ key.name }}</strong
              ><small
                ><code>{{ key.prefix }}••••••••</code></small
              >
            </td>
            <td>
              <n-tag
                :type="key.enabled ? 'success' : 'default'"
                size="small"
                :bordered="false"
                >{{ key.enabled ? "已启用" : "已停用" }}</n-tag
              >
            </td>
            <td>
              {{
                key.last_used
                  ? new Date(key.last_used).toLocaleString()
                  : "尚未使用"
              }}
            </td>
            <td class="actions">
              <n-button size="small" quaternary @click="confirmReveal(key)"
                >查看</n-button
              ><n-popconfirm @positive-click="rotate(key)"
                ><template #trigger
                  ><n-button size="small" quaternary :disabled="busy"
                    >轮换</n-button
                  ></template
                >轮换后旧密钥立即失效，继续？</n-popconfirm
              ><n-button
                size="small"
                quaternary
                :loading="busy"
                @click="enabled(key)"
                >{{ key.enabled ? "停用" : "启用" }}</n-button
              >
            </td>
          </tr>
          <tr v-if="!keys.length">
            <td colspan="4" class="empty">
              还没有托管密钥。创建一个，开始区分不同 Agent 的用量。<br />原有环境密钥仍可使用，其用量归入
              legacy。
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
  <n-modal
    :show="!!target"
    preset="card"
    :title="
      secret
        ? action === 'rotate'
          ? '新密钥'
          : '完整 API key'
        : action === 'rotate'
          ? '确认轮换密钥'
          : '确认查看完整密钥'
    "
    class="dialog"
    @update:show="
      (show: boolean) => {
        if (!show) {
          target = undefined;
          token = '';
          secret = '';
        }
      }
    "
    ><template v-if="secret">
      <p v-if="action === 'rotate'">旧密钥已失效，请复制并更新客户端配置。</p>
      <p v-else>仅提供给你信任的客户端。不要发送到聊天记录或公开仓库。</p>
      <n-input :value="secret" readonly aria-label="完整 API key" />
      <n-button type="primary" @click="copy">{{
        copied ? "已复制" : "复制密钥"
      }}</n-button>
    </template>
    <template v-else>
      <p>请输入管理口令，确认这是你本人操作。</p>
      <n-input
        v-model:value="token"
        type="password"
        placeholder="管理口令"
        @keydown.enter="reveal"
      />
      <n-alert v-if="error" type="error">{{ error }}</n-alert>
      <n-button
        type="primary"
        :loading="busy"
        :disabled="!token"
        @click="reveal"
        >确认</n-button
      >
    </template></n-modal
  >
  <n-modal
    :show="!!secret && !target"
    preset="card"
    title="完整 API key"
    class="dialog"
    @update:show="
      (show: boolean) => {
        if (!show) secret = '';
      }
    "
    ><p>仅提供给你信任的客户端。不要发送到聊天记录或公开仓库。</p>
    <n-input :value="secret" readonly aria-label="完整 API key" /><n-button
      type="primary"
      @click="copy"
      >{{ copied ? "已复制" : "复制密钥" }}</n-button
    ></n-modal
  >
</template>
