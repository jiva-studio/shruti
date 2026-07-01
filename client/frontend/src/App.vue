<script setup>
import { ref, reactive, computed, onMounted } from "vue";

// Wails injects these globals at runtime. Guard so `npm run dev` in a plain
// browser doesn't crash.
const wailsGo = () => window?.go?.main?.App;
const wailsRuntime = () => window?.runtime;

const recording = ref(false);
const busy = ref(false);
const summary = ref("");
const errorMsg = ref("");

// Device selection (dropdowns): system = a sink (we capture its monitor),
// mic = a source. Populated from the Go backend on mount.
const sinks = ref([]);
const sources = ref([]);
const systemDevice = ref("");
const micDevice = ref("");
const lang = ref("ru");
const providerName = ref("parakeet");
const showDevices = ref(false);

async function loadDevices() {
  const go = wailsGo();
  if (!go?.ListAudioDevices) return;
  try {
    const devs = (await go.ListAudioDevices()) || [];
    sinks.value = devs.filter((d) => d.kind === "sink");
    sources.value = devs.filter((d) => d.kind === "source");
    // Prefer the sink that is CURRENTLY playing audio (state=running) — that's
    // where the meeting/video sound actually goes, regardless of the OS default.
    const activeSink = sinks.value.find((d) => d.active);
    if (activeSink) systemDevice.value = activeSink.id;
    else if (!systemDevice.value && sinks.value.length)
      systemDevice.value = sinks.value[0].id;
    if (!micDevice.value && sources.value.length)
      micDevice.value = sources.value[0].id;
  } catch (e) {
    errorMsg.value = "Не удалось получить список устройств: " + String(e);
  }
}

// Single mixed transcript: committed lines + the live (partial) tail.
const transcript = reactive({ finals: [], partial: "" });

// The host sends the partial as the whole cumulative hypothesis, which
// duplicates everything already committed above. Show only its live tail.
const partialTail = computed(() => {
  const p = transcript.partial;
  return p.length > 160 ? "…" + p.slice(-160) : p;
});

function applyUpdate(up) {
  if (up.type === "partial") {
    transcript.partial = up.text;
  } else if (up.type === "final") {
    const text = (up.text || "").trim();
    if (text) {
      const speaker = up.speaker || "";
      const last = transcript.finals[transcript.finals.length - 1];
      // Coalesce consecutive finals from the same speaker into one paragraph —
      // the diarizer emits one final per short segment, which fragments a single
      // person's speech into many lines (and mid-word).
      if (last && last.speaker === speaker) {
        last.text = (last.text + " " + text).replace(/\s+/g, " ").trim();
      } else {
        transcript.finals.push({ text, speaker, ts: up.ts_ms });
      }
    }
    transcript.partial = "";
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
      transcript.finals = [];
      transcript.partial = "";
      summary.value = "";
      // Re-scan devices at the moment of Record so «Система» locks onto the
      // sink that is ACTUALLY playing now (▶) — the audio output only reveals
      // itself as "running" while sound flows, so a pick made at launch is stale.
      await loadDevices();
      const err = await go.StartRecording(
        providerName.value,
        systemDevice.value,
        micDevice.value,
        lang.value,
      );
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
  loadDevices();
});
</script>

<template>
  <div class="wrap">
    <header class="topbar">
      <div class="brand">
        <span class="dot" :class="{ live: recording }"></span>
        Shruti
      </div>
      <div class="topctl">
        <select v-model="providerName" :disabled="recording" title="Движок распознавания">
          <option value="parakeet">Локально</option>
          <option value="deepgram">Deepgram</option>
        </select>
        <button class="refresh" :disabled="recording" @click="showDevices = !showDevices" title="Выбор устройств">⚙</button>
        <select v-model="lang" :disabled="recording" title="Язык распознавания">
          <option value="ru">Русский</option>
          <option value="en">English</option>
        </select>
        <button class="refresh" :disabled="recording" @click="loadDevices" title="Обновить список устройств">⟳</button>
        <button
          class="record"
          :class="{ recording }"
          :disabled="busy"
          @click="toggle"
        >
          {{ recording ? "Стоп" : "Запись" }}
        </button>
      </div>
    </header>

    <p v-if="errorMsg" class="error">{{ errorMsg }}</p>

    <div class="controls" v-if="showDevices">
      <label>
        Микрофон (я)
        <select v-model="micDevice" :disabled="recording">
          <option v-for="d in sources" :key="d.id" :value="d.id">{{ d.label }}</option>
        </select>
      </label>
      <label>
        Система (они)
        <select v-model="systemDevice" :disabled="recording">
          <option v-for="d in sinks" :key="d.id" :value="d.id">{{ (d.active ? "▶ " : "") + d.label }}</option>
        </select>
      </label>
    </div>

    <div class="transcript">
      <p v-for="(line, i) in transcript.finals" :key="'f' + i" class="final">
        <span v-if="line.speaker" class="who">{{ line.speaker }}:</span>{{ line.text }}
      </p>
      <p v-if="transcript.partial" class="partial">{{ partialTail }}</p>
      <p v-if="!transcript.finals.length && !transcript.partial && recording" class="hint">
        Слушаю… (первые слова через ~2 сек)
      </p>
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

.topctl {
  display: flex;
  align-items: center;
  gap: 8px;
}
.controls {
  display: flex;
  gap: 16px;
}
.controls label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  flex: 1;
  min-width: 0;
}
select {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid #33333d;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}
.refresh {
  background: var(--panel-2);
  color: var(--text);
  border: 1px solid #33333d;
  border-radius: 6px;
  padding: 7px 10px;
  cursor: pointer;
}

.transcript {
  background: var(--panel);
  border-radius: 10px;
  padding: 16px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 17px;
}

.who {
  color: var(--mic);
  font-weight: 600;
  margin-right: 6px;
}

.hint {
  margin: 0;
  color: var(--muted);
  font-style: italic;
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
