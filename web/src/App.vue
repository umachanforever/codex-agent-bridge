<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  NConfigProvider,
  NButton,
  NInput,
  NAlert,
  NSpin,
  NSelect,
  NCheckbox,
  darkTheme,
} from "naive-ui";
import { isDark, themeMode } from "./theme";
import { api, type Overview } from "./api";
import KeysPanel from "./KeysPanel.vue";
import UsagePanel from "./UsagePanel.vue";
import SettingsPanel from "./SettingsPanel.vue";

/** Root shell owns login and navigation, feature panels own their data. */
const loggedIn = ref(false),
  restoringSession = ref(true),
  busy = ref(true),
  token = ref(""),
  error = ref(""),
  page = ref("概览");
const overview = ref<Overview>();
const remember = ref(true),
  localLogin = ref(false);
const theme = computed(() => ({
  common: {
    primaryColor: isDark.value ? "#63d5bf" : "#087f70",
    primaryColorHover: isDark.value ? "#8ae4d2" : "#09695e",
    primaryColorPressed: isDark.value ? "#45b59f" : "#07574f",
    borderRadius: "7px",
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  },
}));
async function refresh() {
  overview.value = await api<Overview>("overview");
}
async function login() {
  busy.value = true;
  error.value = "";
  try {
    await api("login", { token: token.value, remember: remember.value });
    token.value = "";
    await refresh();
    loggedIn.value = true;
  } catch (e) {
    error.value = String((e as Error).message);
  } finally {
    busy.value = false;
  }
}
/** Explicit local opt-in still obtains an HttpOnly session and CSRF token. */
async function enterLocal() {
  busy.value = true;
  error.value = "";
  try {
    await api("local-login", {});
    await refresh();
    loggedIn.value = true;
  } catch (cause) {
    error.value = (cause as Error).message;
  } finally {
    busy.value = false;
  }
}
async function logout() {
  try {
    await api("logout", {});
    loggedIn.value = false;
    overview.value = undefined;
    error.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}
onMounted(async () => {
  try {
    localLogin.value = (await api<{ localLogin: boolean }>("auth")).localLogin;
  } catch {
    /* Default to password when discovery fails. */
  }
  try {
    await api("session");
    await refresh();
    loggedIn.value = true;
  } catch {
    loggedIn.value = false;
    if (localLogin.value) await enterLocal();
  } finally {
    restoringSession.value = false;
    busy.value = false;
  }
});
</script>

<template>
  <n-config-provider
    :theme="isDark ? darkTheme : null"
    :theme-overrides="theme"
  >
    <div class="theme-control">
      <n-select
        v-model:value="themeMode"
        aria-label="外观主题"
        size="small"
        :options="[
          { label: '跟随系统', value: 'system' },
          { label: '浅色主题', value: 'light' },
          { label: '深色主题', value: 'dark' },
        ]"
      />
    </div>
    <div v-if="restoringSession" class="login-shell" aria-busy="true">
      <div class="session-loading" role="status" aria-live="polite">
        <n-spin size="small" />
        <p>正在恢复管理会话…</p>
      </div>
    </div>
    <div v-else-if="!loggedIn" class="login-shell">
      <div class="login-panel">
        <div class="wordmark">Codex <span>Bridge</span></div>
        <h1>管理你的本地桥接</h1>
        <p>使用独立管理口令登录。客户端 API key 不具备管理权限。</p>
        <n-alert v-if="error" type="error" class="notice">{{ error }}</n-alert>
        <form @submit.prevent="login">
          <label for="admin-token">管理口令</label
          ><n-input
            id="admin-token"
            v-model:value="token"
            type="password"
            show-password-on="click"
            placeholder="输入管理口令"
            autocomplete="current-password"
          />
          <n-checkbox v-model:checked="remember" class="remember-login"
            >记住登录 30 天（仅在自己的设备上使用）</n-checkbox
          >
          <n-button
            attr-type="submit"
            type="primary"
            block
            :loading="busy"
            :disabled="!token"
            >登录管理台</n-button
          >
        </form>
        <n-button v-if="localLogin" block @click="enterLocal" :loading="busy"
          >本机免登录进入</n-button
        >
        <p class="fine">
          首次启动会在状态目录的
          <code>admin/admin-token</code> 文件生成口令。不会展示或索取 Codex
          上游凭据。
        </p>
      </div>
    </div>
    <div v-else class="shell">
      <aside>
        <div class="wordmark">Codex <span>Bridge</span></div>
        <p class="sidebar-caption">本地 Agent 工作台</p>
        <nav aria-label="主导航">
          <button
            v-for="item in ['概览', '用量与请求', 'API keys', '设置']"
            :key="item"
            :class="{ selected: page === item }"
            @click="page = item"
          >
            {{ item }}
          </button>
        </nav>
        <div class="sidebar-bottom">
          <span :class="['status-dot', { online: overview?.ready }]"></span
          >{{ overview?.ready ? "桥接已就绪" : "桥接未就绪" }}
          <p>认证留在本机，调用保持透明。</p>
          <n-button quaternary @click="logout">退出管理台</n-button>
        </div>
      </aside>
      <main>
        <header>
          <div>
            <h1>{{ page }}</h1>
            <p>
              {{
                page === "概览"
                  ? "关键指标、用量趋势与桥接运行状态。"
                  : page === "API keys"
                    ? "为不同 Agent 分配独立密钥，随时查看或停用。"
                    : page === "设置"
                      ? "客户端接入、运行参数与认证部署。"
                      : "按日期、密钥和模型查询调用明细与用量。"
              }}
            </p>
          </div>
        </header>
        <n-alert v-if="error" type="error">{{ error }}</n-alert>
        <n-alert v-if="localLogin" type="warning" class="notice"
          >本机免登录已开启：请勿通过代理或隧道开放此后台。查看、轮换密钥仍需管理口令。</n-alert
        >
        <n-spin :show="!overview">
          <UsagePanel
            v-if="page === '概览' || page === '用量与请求'"
            :key="page"
            :overview="overview"
            :detailed="page === '用量与请求'"
            @refresh="refresh"
            @details="page = '用量与请求'"
          />
          <KeysPanel v-if="page === 'API keys'" />
          <SettingsPanel
            v-if="page === '设置' && overview"
            :overview="overview"
            @saved="refresh"
          />
        </n-spin>
        <footer>
          Codex app-server bridge
          <span>默认保留最近 90 天记录 · token 仅使用上游真实计数</span>
        </footer>
      </main>
    </div>
  </n-config-provider>
</template>
