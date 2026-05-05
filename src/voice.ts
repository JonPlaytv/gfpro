import { VRM } from '@pixiv/three-vrm';

export class VoiceManager {
  private currentVrm: VRM | null = null;
  private isSpeaking: boolean = false;
  private audioContext: AudioContext | null = null;
  private audioSource: AudioBufferSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private dataArray: Uint8Array<ArrayBuffer> | null = null;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    this.analyser = this.audioContext.createAnalyser();
    this.analyser.fftSize = 256;
    const bufferLength = this.analyser.frequencyBinCount;
    this.dataArray = new Uint8Array(bufferLength) as Uint8Array<ArrayBuffer>;
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
      
      // Calculate average volume
      let sum = 0;
      for (let i = 0; i < this.dataArray!.length; i++) {
        sum += this.dataArray![i];
      }
      const average = sum / this.dataArray!.length;
      
      // Map volume to 'aa' expression (0 to 1)
      const value = Math.min(1.0, average / 40); // Tweak divisor for sensitivity
      this.currentVrm.expressionManager.setValue('aa', value);
    }
  }

  private resetMouth() {
    if (this.currentVrm && this.currentVrm.expressionManager) {
      this.currentVrm.expressionManager.setValue('aa', 0);
    }
  }

  private normalizeEmotionTags(text: string): string {
    return text
      .replace(/\[([a-zA-Z][a-zA-Z0-9_-]*)\[/g, '[$1]')
      .replace(/\[([a-zA-Z][a-zA-Z0-9_-]*)\](?!\s|$|[.,!?;:])/g, '[$1] ');
  }

  public async setVoice(refAudioB64: string, refText: string, refLang: string = 'ja') {
    try {
      const response = await fetch('http://localhost:8000/set_voice', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ 
          ref_audio_b64: refAudioB64, 
          ref_text: refText,
          ref_lang: refLang
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
