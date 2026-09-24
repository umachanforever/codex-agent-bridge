import { computed, ref, watchEffect } from "vue";

/** Only a non-sensitive display preference is persisted in this browser. */
export type ThemeMode = "system" | "light" | "dark";
const storageKey = "codex-bridge-theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");
const systemDark = ref(media.matches);
/** Storage may be disabled by the browser; theme switching still works. */
function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    return "system";
  }
}
export const themeMode = ref<ThemeMode>(readMode());
export const isDark = computed(
  () =>
    themeMode.value === "dark" ||
    (themeMode.value === "system" && systemDark.value),
);
media.addEventListener("change", (event) => {
  systemDark.value = event.matches;
});
window.addEventListener("storage", (event) => {
  if (event.key === storageKey || event.key === null)
    themeMode.value = readMode();
});
watchEffect(() => {
  document.documentElement.dataset.theme = isDark.value ? "dark" : "light";
  document.documentElement.style.colorScheme = isDark.value ? "dark" : "light";
  try {
    localStorage.setItem(storageKey, themeMode.value);
  } catch {
    /* Optional persistence. */
  }
});
