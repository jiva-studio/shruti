<script setup>
import { ref, reactive, onMounted } from "vue";

// Wails injects these globals at runtime. Guard so `npm run dev` in a plain
// browser doesn't crash.
const wailsGo = () => window?.go?.main?.App;
const wailsRuntime = () => window?.runtime;

const recording = ref(false);
const busy = ref(false);
const summary = ref("");
const errorMsg = ref("");

// Per-channel state: committed final lines + the live (partial) tail.
const columns = reactive({
  mic: { finals: [], partial: "" },
  system: { finals: [], partial: "" },
});

function applyUpdate(up) {
  const col = columns[up.channel];
  if (!col) return;
  if (up.type === "partial") {
    col.partial = up.text;
  } else if (up.type === "final") {
    if (up.text && up.text.trim() !== "") {
      col.finals.push({ text: up.text, ts: up.ts_ms });
    }
    col.partial = "";
  }
}

async function toggle() {
  if (busy.value) return;
  errorMsg.value = "";
  const go = wailsGo();
  if (!go) {
    errorMsg.value = "Wails runtime unavailable (run inside the desktop app).";
    return;
  }
  busy.value = true;
  try {
    if (!recording.value) {
      columns.mic.finals = [];
      columns.mic.partial = "";
      columns.system.finals = [];
      columns.system.partial = "";
      summary.value = "";
      const err = await go.StartRecording();
      if (err) {
        errorMsg.value = err;
      } else {
        recording.value = true;
      }
    } else {
      const result = await go.StopRecording();
      recording.value = false;
      if (result && result.startsWith("ERROR: ")) {
        errorMsg.value = result.slice("ERROR: ".length);
      } else {
        summary.value = result || "";
      }
    }
  } catch (e) {
    errorMsg.value = String(e);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  const rt = wailsRuntime();
  if (rt?.EventsOn) {
    rt.EventsOn("shruti:update", applyUpdate);
  }
});
</script>

<template>
  <div class="wrap">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="{ live: recording }"></span>
        Shruti
      </div>
      <button
        class="record"
        :class="{ recording }"
        :disabled="busy"
        @click="toggle"
      >
        {{ recording ? "Стоп" : "Запись" }}
      </button>
    </header>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div class="columns">
      <section class="col">
        <h2 class="label mic">Я</h2>
        <div class="lines">
          <p v-for="(line, i) in columns.mic.finals" :key="'mf' + i" class="final">
            {{ line.text }}
          </p>
          <p v-if="columns.mic.partial" class="partial">
            {{ columns.mic.partial }}
          </p>
        </div>
      </section>

      <section class="col">
        <h2 class="label sys">Они</h2>
        <div class="lines">
          <p v-for="(line, i) in columns.system.finals" :key="'sf' + i" class="final">
            {{ line.text }}
          </p>
          <p v-if="columns.system.partial" class="partial">
            {{ columns.system.partial }}
          </p>
        </div>
      </section>
    </div>

    <section v-if="summary" class="summary">
      <h3>Резюме встречи</h3>
      <pre>{{ summary }}</pre>
    </section>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 16px;
  gap: 12px;
}

.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 600;
  font-size: 18px;
}

.dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--muted);
}

.dot.live {
  background: var(--rec);
  box-shadow: 0 0 8px var(--rec);
  animation: pulse 1.2s infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.4;
  }
}

.record {
  border: none;
  border-radius: 8px;
  padding: 10px 22px;
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  background: var(--accent);
  cursor: pointer;
}

.record.recording {
  background: var(--rec);
}

.record:disabled {
  opacity: 0.6;
  cursor: default;
}

.error {
  margin: 0;
  padding: 8px 12px;
  border-radius: 6px;
  background: #3a1f22;
  color: #ff9d9d;
  font-size: 13px;
}

.columns {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
  flex: 1;
  min-height: 0;
}

.col {
  background: var(--panel);
  border-radius: 10px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.label {
  margin: 0 0 8px;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.label.mic {
  color: var(--mic);
}

.label.sys {
  color: var(--sys);
}

.lines {
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.final {
  margin: 0;
  line-height: 1.4;
}

.partial {
  margin: 0;
  line-height: 1.4;
  color: var(--muted);
  font-style: italic;
}

.summary {
  background: var(--panel-2);
  border-radius: 10px;
  padding: 12px 16px;
  max-height: 40%;
  overflow-y: auto;
}

.summary h3 {
  margin: 0 0 8px;
  color: var(--accent);
}

.summary pre {
  margin: 0;
  white-space: pre-wrap;
  font-family: inherit;
  line-height: 1.5;
}
</style>
