import { VRM } from '@pixiv/three-vrm';

export class VoiceManager {
  private currentVrm: VRM | null = null;
  private isSpeaking: boolean = false;
  private audioContext: AudioContext | null = null;
  private audioSource: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;
  private timeDataArray: Uint8Array<ArrayBuffer> | null = null;
  private mouthValue = 0;
  private mouthPhase = 0;
  private visemeValues = {
    aa: 0,
    ee: 0,
    ih: 0,
    oh: 0,
    ou: 0,
  };

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    const bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;
    this.timeDataArray = new Uint8Array(this.analyser.fftSize) as Uint8Array<ArrayBuffer>;
  }

  public setVrm(vrm: VRM) {
    this.currentVrm = vrm;
  }

  public async speak(text: string, targetLang: string = 'ja') {
    const normalizedText = this.normalizeEmotionTags(text);
    console.log('VoiceManager: Speaking with GPT-SoVITS...', normalizedText, 'Language:', targetLang);
    if (this.isSpeaking) {
      this.stop();
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

      const response = await fetch('http://localhost:8000/tts', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          gen_text: normalizedText,
          target_lang: targetLang
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('GPT-SoVITS server error');
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioData = arrayBuffer as ArrayBuffer;
      const audioBuffer = await this.audioContext!.decodeAudioData(audioData);

      this.playAudio(audioBuffer);
    } catch (error) {
      console.error('Error with GPT-SoVITS:', error);
    }
  }

  private playAudio(buffer: AudioBuffer) {
    if (this.audioSource) {
      this.audioSource.stop();
    }

    this.audioSource = this.audioContext!.createBufferSource();
    this.audioSource.buffer = buffer;
    
    // Connect source to analyser and then to destination
    this.audioSource.connect(this.analyser!);
    this.analyser!.connect(this.audioContext!.destination);
    
    this.audioSource.onended = () => {
      this.isSpeaking = false;
      this.resetMouth();
    };

    this.isSpeaking = true;
    this.audioSource.start(0);
  }

  public stop() {
    if (this.audioSource) {
      this.audioSource.stop();
      this.audioSource = null;
    }
    this.isSpeaking = false;
    this.resetMouth();
  }

  public update() {
    if (this.isSpeaking && this.currentVrm && this.currentVrm.expressionManager && this.analyser) {
      this.analyser.getByteFrequencyData(this.dataArray!);
      this.analyser.getByteTimeDomainData(this.timeDataArray!);
      
      let rmsSum = 0;
      for (let i = 0; i < this.timeDataArray!.length; i++) {
        const centered = (this.timeDataArray![i] - 128) / 128;
        rmsSum += centered * centered;
      }
      const rms = Math.sqrt(rmsSum / this.timeDataArray!.length);
      const volume = Math.min(1, Math.max(0, (rms - 0.015) / 0.16));

      const low = this.averageFrequencyRange(1, 7) / 255;
      const mid = this.averageFrequencyRange(8, 26) / 255;
      const high = this.averageFrequencyRange(27, 64) / 255;

      this.mouthPhase += 0.18 + volume * 0.42 + high * 0.08;
      const syllablePulse = (Math.sin(this.mouthPhase) + 1) * 0.5;
      const consonantDip = 0.38 + syllablePulse * 0.62;
      const target = Math.min(1.0, Math.pow(volume, 0.72) * 1.25) * consonantDip;
      const smoothing = target > this.mouthValue ? 0.58 : 0.34;
      this.mouthValue += (target - this.mouthValue) * smoothing;

      this.setViseme('aa', this.mouthValue * (0.55 + mid * 0.45));
      this.setViseme('ee', this.mouthValue * high * 0.38);
      this.setViseme('ih', this.mouthValue * mid * 0.3);
      this.setViseme('oh', this.mouthValue * low * 0.5);
      this.setViseme('ou', this.mouthValue * low * 0.35);
    } else if (this.currentVrm && this.currentVrm.expressionManager) {
      this.mouthValue += (0 - this.mouthValue) * 0.35;
      if (this.mouthValue < 0.01) {
        this.mouthValue = 0;
      }
      this.setViseme('aa', this.mouthValue);
      this.setViseme('ee', 0);
      this.setViseme('ih', 0);
      this.setViseme('oh', this.mouthValue * 0.2);
      this.setViseme('ou', 0);
    }
  }

  private averageFrequencyRange(start: number, end: number): number {
    if (!this.dataArray) return 0;
    const lastIndex = Math.min(end, this.dataArray.length - 1);
    let sum = 0;
    let count = 0;
    for (let i = start; i <= lastIndex; i++) {
      sum += this.dataArray[i];
      count++;
    }
    return count ? sum / count : 0;
  }

  private setViseme(name: keyof VoiceManager['visemeValues'], target: number) {
    if (!this.currentVrm?.expressionManager) return;
    const value = Math.max(0, Math.min(1, target));
    const current = this.visemeValues[name];
    const smoothing = value > current ? 0.55 : 0.3;
    const next = current + (value - current) * smoothing;
    this.visemeValues[name] = next;
    this.currentVrm.expressionManager.setValue(name, next);
  }

  private resetMouth() {
    if (this.currentVrm && this.currentVrm.expressionManager) {
      this.mouthValue = 0;
      this.mouthPhase = 0;
      (Object.keys(this.visemeValues) as Array<keyof VoiceManager['visemeValues']>).forEach((name) => {
        this.visemeValues[name] = 0;
        this.currentVrm!.expressionManager!.setValue(name, 0);
      });
    }
  }

  private normalizeEmotionTags(text: string): string {
    return text
      .replace(/\[([a-zA-Z][a-zA-Z0-9_-]*)\[/g, '[$1]')
      .replace(/\[([a-zA-Z][a-zA-Z0-9_-]*)\](?!\s|$|[.,!?;:])/g, '[$1] ');
  }

  public async setVoice(
    refAudioB64: string,
    refText: string,
    refLang: string = 'ja',
    emotion: string = 'neutral'
  ) {
    try {
      const response = await fetch('http://localhost:8000/set_voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          ref_audio_b64: refAudioB64, 
          ref_text: refText,
          ref_lang: refLang,
          emotion,
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        console.error('set_voice failed:', response.status, detail);
      }
      return response.ok;
    } catch (error) {
      console.error('Error setting voice:', error);
      return false;
    }
  }

  public async checkVoice() {
    try {
      const response = await fetch('http://localhost:8000/has_voice');
      const data = await response.json();
      return data.exists;
    } catch (error) {
      console.error('Error checking voice:', error);
      return false;
    }
  }
}
