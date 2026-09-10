/**
 * Gemini Live voice backend — the free-tier alternative to OpenAI Realtime.
 *
 * Provider selection is server-authoritative: `initVoiceCommands` (this module)
 * routes to Gemini Live only when the dev server reports `GEMINI_API_KEY` is
 * configured (via the `import.meta.env.GEV_VOICE_PROVIDER` define); otherwise
 * it falls back to the existing OpenAI Realtime controller unchanged.
 *
 * Unlike OpenAI Realtime (WebRTC + SDP + a data channel), Gemini Live is a
 * WebSocket stream (Google's BidiGenerateContent). The browser connects to a
 * same-origin relay (`/api/gemini/live`) that the dev server brokers so the
 * GEMINI_API_KEY never reaches the client — see geminiLiveProxy() in
 * vite.config.js. Audio is raw PCM: 16 kHz mono in, 24 kHz mono out.
 *
 * The tool layer is reused unchanged: `createGevActionRunner` from gevActions.js
 * is the same runner the OpenAI controller uses, and the tool registry +
 * instructions stay a single source of truth in vite.config.js (served here via
 * GET /api/gemini/live/config).
 *
 * @module voice/geminiLive
 */

import { createGevActionRunner } from './gevActions.js';
import {
  createVoiceControl,
  initGevVoiceCommands,
  isPushToTalkKey,
  silenceRadioForVoice,
  shouldHandlePushToTalkKeyDown,
} from './gevRealtime.js';

const CONFIG_URL = '/api/gemini/live/config';
const LIVE_WS_PATH = '/api/gemini/live';
const GEMINI_INPUT_SAMPLE_RATE = 16000;
const GEMINI_OUTPUT_SAMPLE_RATE = 24000;
const CONFIG_FETCH_TIMEOUT_MS = 8000;
const WS_CONNECT_TIMEOUT_MS = 15000;

const STATUS_LABELS = {
  idle: 'OFF',
  connecting: 'CONNECTING',
  listening: 'LISTENING',
  executing: 'EXECUTING',
  error: 'ERROR',
};

/**
 * Fetch the Gemini Live session config the server builds from the shared
 * instruction + tool registry. Resolves to null when unavailable so the
 * controller can fail honestly instead of throwing.
 */
async function fetchGeminiConfig() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(CONFIG_URL, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Linear-interpolation downsample of a Float32 mono buffer to 16 kHz. */
function downsampleTo16k(input, inputRate) {
  const ratio = inputRate / GEMINI_INPUT_SAMPLE_RATE;
  const outLength = Math.floor(input.length / ratio);
  if (outLength <= 0) return new Float32Array(0);
  const output = new Float32Array(outLength);
  for (let i = 0; i < outLength; i += 1) {
    const position = i * ratio;
    const left = Math.floor(position);
    const right = Math.min(left + 1, input.length - 1);
    const fraction = position - left;
    output[i] = input[left] * (1 - fraction) + input[right] * fraction;
  }
  return output;
}

/** Float32 [-1, 1] → Int16 PCM. */
function floatToInt16Pcm(float32) {
  const output = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i += 1) {
    const sample = Math.max(-1, Math.min(1, float32[i]));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }
  return output;
}

/** Int16 PCM → base64 (chunked so the call stack never overflows). */
function int16ToBase64(int16) {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** base64 → Uint8Array. */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function compactText(value, maxLength = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

/**
 * Route to the right voice backend. Gemini Live when the server configured a
 * GEMINI_API_KEY; the original OpenAI Realtime controller otherwise.
 */
export function initVoiceCommands(deps) {
  if (import.meta.env.GEV_VOICE_PROVIDER === 'gemini') {
    return initGeminiVoiceCommands(deps);
  }
  return initGevVoiceCommands(deps);
}

export function initGeminiVoiceCommands({
  viewer,
  styleManager,
  dataManager,
  sceneDirector = null,
  annotations = null,
}) {
  if (window.__gevVoiceCommands && typeof window.__gevVoiceCommands.stop === 'function') {
    window.__gevVoiceCommands.stop({ removeUi: true });
  }
  const runner = createGevActionRunner({ viewer, styleManager, dataManager, sceneDirector, annotations });
  const ui = createVoiceControl({ reset: true });
  const radioLayer = dataManager?.layers?.get('radio')?.module || null;
  const controller = new GeminiLiveController({ runner, ui, radioLayer });

  // Deferred annotation outlines finish AFTER their tool result returned. Feed
  // the final outcome into the conversation the same way the OpenAI controller
  // does, so the model can honestly confirm — or correct — what it narrated.
  if (annotations && typeof annotations.onOutlineEvent === 'function') {
    controller.annotationEventUnsubscribe = annotations.onOutlineEvent((event) => {
      controller.notifyMapEvent({ type: 'map_annotation_outline', ...event });
    });
  }

  controller.buttonHandler = () => {
    if (controller.isActive()) controller.stop();
    else controller.start({ pushToTalk: false });
  };
  ui.button.addEventListener('click', controller.buttonHandler);
  controller.bindPushToTalkShortcut();
  controller.hideProviderChrome();
  window.__gevVoiceCommands = controller;
  return controller;
}

export class GeminiLiveController {
  constructor({ runner, ui, radioLayer = null }) {
    this.runner = runner;
    this.ui = ui;
    this.radioLayer = radioLayer;
    this.radioVoiceDucked = false;

    this.status = 'idle';
    this.config = null;
    this.ws = null;
    this.stream = null;
    this.audioContext = null;
    this.sourceNode = null;
    this.processorNode = null;
    this.processorMute = null;

    // Monotonic generation token: every start()/stop() bumps it, and an
    // in-flight start() bails after each await when it no longer matches, so a
    // stop() mid-connect cannot leave an orphaned mic/WebSocket behind.
    this.startEpoch = 0;
    this.closed = false;
    this.activeToolControllers = new Set();

    this.buttonHandler = null;
    this.annotationEventUnsubscribe = null;
    this.pushToTalkMode = false;
    this.pushToTalkKeyHeld = false;
    this.spaceKeyHeld = false;
    this.shortcutKeyDownHandler = null;
    this.shortcutKeyUpHandler = null;
    this.shortcutBlurHandler = null;
  }

  isActive() {
    return this.status !== 'idle' && this.status !== 'error';
  }

  setStatus(status, detail = '') {
    this.status = status;
    if (this.ui?.status) this.ui.status.textContent = STATUS_LABELS[status] || String(status).toUpperCase();
    if (this.ui?.detail) {
      this.ui.detail.textContent = detail
        || (status === 'idle' ? 'VOICE STANDBY' : 'GEMINI LIVE');
    }
    if (this.ui?.root) this.ui.root.dataset.status = status;
  }

  /** The cost meter and tier toggle are OpenAI-only; Gemini runs on its free tier. */
  hideProviderChrome() {
    const cost = this.ui?.costValue?.parentElement;
    if (cost) cost.style.display = 'none';
    if (this.ui?.tierButton) this.ui.tierButton.style.display = 'none';
  }

  setRadioVoiceDucking(ducked) {
    const next = Boolean(ducked);
    if (next === this.radioVoiceDucked) return;
    this.radioVoiceDucked = next;
    this.radioLayer?.setVoiceDucked?.(next);
  }

  pauseRadioForVoice() {
    return silenceRadioForVoice({
      duckRadio: () => this.setRadioVoiceDucking(true),
      pauseRadio: () => this.radioLayer?.pause?.({ origin: 'voice-duck' }),
    });
  }

  async start({ pushToTalk = false } = {}) {
    if (this.isActive()) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.AudioContext && !window.webkitAudioContext) {
      this.setStatus('error', 'Microphone support unavailable');
      return;
    }
    this.pauseRadioForVoice();
    this.stop({ preserveStatus: true });
    this.pushToTalkMode = pushToTalk;
    this.closed = false;
    const epoch = ++this.startEpoch;
    this.setStatus('connecting', 'GEMINI LIVE');

    try {
      const config = await fetchGeminiConfig();
      if (epoch !== this.startEpoch) return;
      if (!config?.configured) {
        throw new Error('GEMINI_API_KEY is not set — add it in Provider Settings.');
      }
      this.config = config;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      if (epoch !== this.startEpoch) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      this.stream = stream;

      this.startAudioGraph();

      await this.connectLive();
      if (epoch !== this.startEpoch) return;
      this.setStatus('listening', 'GEMINI LIVE');
    } catch (error) {
      if (epoch !== this.startEpoch) return;
      this.setStatus('error', error?.message || 'Gemini Live failed to start');
      this.teardownSession();
    }
  }

  startAudioGraph() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    const context = new AudioContextClass();
    const source = context.createMediaStreamSource(this.stream);
    const processor = context.createScriptProcessor(4096, 1, 1);
    // ScriptProcessor only fires while connected to the destination graph. Route
    // through a zero-gain node so the mic never echoes back through the speaker.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(processor);
    processor.connect(mute);
    mute.connect(context.destination);
    processor.onaudioprocess = (event) => this.onMicData(event.inputBuffer.getChannelData(0));
    this.audioContext = context;
    this.sourceNode = source;
    this.processorNode = processor;
    this.processorMute = mute;
    context.resume().catch(() => {});
  }

  onMicData(float32) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const downsampled = downsampleTo16k(float32, this.audioContext.sampleRate);
    if (!downsampled.length) return;
    const data = int16ToBase64(floatToInt16Pcm(downsampled));
    this.sendJson({
      realtimeInput: {
        mediaChunks: [{ mimeType: 'audio/pcm;rate=16000', data }],
      },
    });
  }

  connectLive() {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${protocol}//${window.location.host}${LIVE_WS_PATH}`);
      this.ws = ws;
      let settled = false;
      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Gemini Live connection timed out'));
        }
      }, WS_CONNECT_TIMEOUT_MS);

      ws.addEventListener('open', () => {
        clearTimeout(connectTimer);
        if (settled) return;
        settled = true;
        this.sendSetup();
        resolve();
      });
      ws.addEventListener('message', (event) => this.onMessage(event.data));
      ws.addEventListener('error', () => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(new Error('Gemini Live connection failed'));
        }
      });
      ws.addEventListener('close', () => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(new Error('Gemini Live connection closed'));
        }
        this.onSocketClosed();
      });
    });
  }

  sendJson(payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(payload));
    return true;
  }

  sendSetup() {
    const functionDeclarations = (this.config?.tools || [])
      .map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters || { type: 'object', properties: {} },
      }))
      .filter((tool) => tool.name);

    this.sendJson({
      setup: {
        model: this.config.model,
        generationConfig: {
          responseModalities: ['AUDIO', 'TEXT'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: this.config.voice } },
          },
        },
        systemInstruction: {
          parts: [{ text: this.config.instructions || '' }],
        },
        tools: [{ functionDeclarations }],
      },
    });
  }

  onMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (message.setupComplete) return;
    if (message.goAway) {
      this.setStatus('idle', 'Gemini Live session ended');
      this.teardownSession();
      return;
    }
    if (message.serverContent) this.onServerContent(message.serverContent);
    if (message.toolCall) this.onToolCall(message.toolCall);
  }

  onServerContent(content) {
    if (!content?.modelTurn?.parts) return;
    let lastText = null;
    for (const part of content.modelTurn.parts) {
      if (part.text) lastText = part.text;
      else if (part.inlineData) this.playAudio(part.inlineData);
      else if (part.functionCall) this.dispatchFunctionCalls([part.functionCall]);
    }
    if (lastText && this.status !== 'executing') {
      this.setStatus('listening', compactText(lastText));
    }
  }

  onToolCall(message) {
    const calls = Array.isArray(message?.functionCalls) ? message.functionCalls : [];
    if (calls.length) this.dispatchFunctionCalls(calls);
  }

  async dispatchFunctionCalls(calls) {
    if (this.closed) return;
    this.setStatus('executing', 'Running command');
    const responses = [];
    for (const call of calls) {
      if (!call || !call.name) continue;
      const controller = new AbortController();
      this.activeToolControllers.add(controller);
      let result;
      try {
        const args = call.args && typeof call.args === 'object' ? call.args : {};
        result = await this.runner(call.name, args, {
          signal: controller.signal,
          isCurrent: () => !this.closed && this.activeToolControllers.has(controller),
        });
      } catch (error) {
        result = { ok: false, error: error?.message || 'GEV command failed', tool: call.name };
      } finally {
        this.activeToolControllers.delete(controller);
      }
      responses.push({
        id: call.id || null,
        name: call.name,
        response: { result: JSON.stringify(result ?? { ok: false, error: 'No result' }) },
      });
    }
    if (responses.length) {
      this.sendJson({ toolResponse: { functionResponses: responses } });
    }
    if (!this.closed) this.setStatus('listening', 'Ask or command');
  }

  playAudio(inlineData) {
    if (!inlineData?.data) return;
    const sampleRate = Number(inlineData.sampleRate) || GEMINI_OUTPUT_SAMPLE_RATE;
    try {
      const bytes = base64ToBytes(inlineData.data);
      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
      if (!int16.length) return;
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i += 1) float32[i] = int16[i] / 32768;
      if (!this.audioContext) return;
      // AudioBufferSourceNode resamples to the context rate automatically, so
      // the buffer can be created directly at Gemini's 24 kHz output rate.
      const buffer = this.audioContext.createBuffer(1, float32.length, sampleRate);
      buffer.copyToChannel(float32, 0);
      const source = this.audioContext.createBufferSource();
      source.buffer = buffer;
      source.connect(this.audioContext.destination);
      source.start();
    } catch (error) {
      console.warn('[GeminiLive] audio playback failed:', error?.message || error);
    }
  }

  /**
   * Inject a background MAP EVENT into the conversation as a user turn — e.g. a
   * deferred annotation outline that resolved or failed after its tool result
   * already returned. Prefaced so the model reads it without needing to speak.
   */
  notifyMapEvent(event) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.sendJson({
      clientContent: {
        turns: [{
          role: 'user',
          parts: [{
            text: `Background map event (no spoken reply needed, but correct yourself if you previously described it as already drawn): ${JSON.stringify(event)}`,
          }],
        }],
      },
    });
  }

  onSocketClosed() {
    if (!this.closed && this.status !== 'idle') {
      this.setStatus('error', 'Gemini Live connection closed');
    }
    this.teardownSession();
  }

  teardownSession() {
    this.closed = true;
    if (this.ws) {
      try { this.ws.close(); } catch { /* no-op */ }
      this.ws = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }
    if (this.processorNode) {
      try { this.processorNode.disconnect(); } catch { /* no-op */ }
      this.processorNode = null;
    }
    if (this.sourceNode) {
      try { this.sourceNode.disconnect(); } catch { /* no-op */ }
      this.sourceNode = null;
    }
    if (this.processorMute) {
      try { this.processorMute.disconnect(); } catch { /* no-op */ }
      this.processorMute = null;
    }
    if (this.audioContext) {
      this.audioContext.close().catch(() => {});
      this.audioContext = null;
    }
  }

  stop({ preserveStatus = false, removeUi = false } = {}) {
    const epoch = ++this.startEpoch;
    this.pushToTalkMode = false;
    this.pushToTalkKeyHeld = false;
    this.teardownSession();
    for (const controller of this.activeToolControllers) {
      try { controller.abort(); } catch { /* no-op */ }
    }
    this.activeToolControllers.clear();
    if (this.annotationEventUnsubscribe && removeUi) {
      try { this.annotationEventUnsubscribe(); } catch { /* no-op */ }
      this.annotationEventUnsubscribe = null;
    }
    if (removeUi && this.ui?.root) {
      this.ui.root.remove();
    }
    this.setRadioVoiceDucking(false);
    if (!preserveStatus && !removeUi) {
      this.setStatus('idle', 'Voice off');
    }
    void epoch;
  }

  bindPushToTalkShortcut() {
    const down = (event) => {
      if (!shouldHandlePushToTalkKeyDown(event)) return;
      event.preventDefault();
      if (this.spaceKeyHeld) return;
      this.spaceKeyHeld = true;
      this.pushToTalkKeyHeld = true;
      if (!this.isActive()) this.start({ pushToTalk: true });
    };
    const up = (event) => {
      if (!isPushToTalkKey(event)) return;
      this.spaceKeyHeld = false;
      this.pushToTalkKeyHeld = false;
      if (this.pushToTalkMode) this.stop();
    };
    const blur = () => {
      if (this.pushToTalkMode) this.stop();
      this.spaceKeyHeld = false;
      this.pushToTalkKeyHeld = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    this.shortcutKeyDownHandler = down;
    this.shortcutKeyUpHandler = up;
    this.shortcutBlurHandler = blur;
  }
}
