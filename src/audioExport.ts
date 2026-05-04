/** F5-TTS expects 24 kHz reference audio; export real PCM WAV from browser recordings (e.g. WebM/Opus). */
const TARGET_SAMPLE_RATE = 24000;

function writeAscii(view: DataView, offset: number, s: string): void {
  for (let i = 0; i < s.length; i++) {
    view.setUint8(offset + i, s.charCodeAt(i));
  }
}

function mixToMono(audioBuffer: AudioBuffer): Float32Array {
  const n = audioBuffer.length;
  const ch = audioBuffer.numberOfChannels;
  if (ch === 1) {
    return audioBuffer.getChannelData(0).slice();
  }
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      out[i] += data[i];
    }
  }
  const scale = 1 / ch;
  for (let i = 0; i < n; i++) {
    out[i] *= scale;
  }
  return out;
}

function resampleLinear(input: Float32Array, inputRate: number, outputRate: number): Float32Array {
  if (inputRate === outputRate) {
    return input;
  }
  const ratio = inputRate / outputRate;
  const outLength = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLength);
  for (let i = 0; i < outLength; i++) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, input.length - 1);
    const t = srcPos - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

function normalizePeak(samples: Float32Array, target = 0.98): void {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) {
      peak = a;
    }
  }
  if (peak > 0.001) {
    const g = target / peak;
    for (let i = 0; i < samples.length; i++) {
      samples[i] *= g;
    }
  }
}

function floatTo16BitPcm(samples: Float32Array): Int16Array {
  const pcm = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return pcm;
}

function buildWavMono16Le(pcm: Int16Array, sampleRate: number): Uint8Array {
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const out = new Uint8Array(buffer);
  out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 44);
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Decode any format the browser can decode (WebM/Opus from MediaRecorder, etc.),
 * mix to mono, resample to 24 kHz, emit 16-bit PCM WAV as raw base64 (no data: prefix).
 */
export async function recordingBlobToWavBase64(blob: Blob): Promise<string> {
  const raw = await blob.arrayBuffer();
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(raw.slice(0));
    let mono = mixToMono(decoded);
    mono = resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);
    normalizePeak(mono);
    const pcm = floatTo16BitPcm(mono);
    const wav = buildWavMono16Le(pcm, TARGET_SAMPLE_RATE);
    return bytesToBase64(wav);
  } finally {
    await ctx.close();
  }
}
