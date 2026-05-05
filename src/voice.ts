import { VRM } from '@pixiv/three-vrm';

export class VoiceManager {
  private currentVrm: VRM | null = null;
  private isSpeaking: boolean = false;
  private audioContext: AudioContext | null = null;
  private audioSource: AudioBufferSourceNode | null = null;

  constructor() {
    this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
  }

  public setVrm(vrm: VRM) {
    this.currentVrm = vrm;
  }

  public async speak(text: string, targetLang: string = 'ja') {
    console.log('VoiceManager: Speaking with GPT-SoVITS...', text, 'Language:', targetLang);
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
          gen_text: text,
          target_lang: targetLang
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error('GPT-SoVITS server error');
      }

      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext!.decodeAudioData(arrayBuffer);

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
    this.audioSource.connect(this.audioContext!.destination);
    
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
    if (this.isSpeaking && this.currentVrm && this.currentVrm.expressionManager) {
      // Procedural Lip Sync while audio is playing
      const value = Math.abs(Math.sin(performance.now() * 0.015));
      this.currentVrm.expressionManager.setValue('aa', value);
    }
  }

  private resetMouth() {
    if (this.currentVrm && this.currentVrm.expressionManager) {
      this.currentVrm.expressionManager.setValue('aa', 0);
    }
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
