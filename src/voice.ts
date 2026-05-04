import { VRM } from '@pixiv/three-vrm';

export class VoiceManager {
  private currentVrm: VRM | null = null;
  private synth: SpeechSynthesis;
  private isSpeaking: boolean = false;

  constructor() {
    this.synth = window.speechSynthesis;
    // Pre-load voices
    this.synth.getVoices();
    this.synth.onvoiceschanged = () => {
      console.log('VoiceManager: Voices loaded', this.synth.getVoices().length);
    };
  }


  public setVrm(vrm: VRM) {
    this.currentVrm = vrm;
  }

  public speak(text: string) {
    console.log('VoiceManager: Speaking...', text);
    if (this.isSpeaking) {
      this.synth.cancel();
    }


    const utterance = new SpeechSynthesisUtterance(text);
    
    utterance.onstart = () => {
      this.isSpeaking = true;
    };

    utterance.onend = () => {
      this.isSpeaking = false;
      this.resetMouth();
    };

    utterance.onerror = () => {
      this.isSpeaking = false;
      this.resetMouth();
    };

    // Try to find a good female voice if available
    const voices = this.synth.getVoices();
    const preferredVoice = voices.find(v => v.name.includes('Google') || v.name.includes('Female') || v.name.includes('Natural'));
    if (preferredVoice) {
      utterance.voice = preferredVoice;
    }

    this.synth.speak(utterance);
  }

  public update() {
    if (this.isSpeaking && this.currentVrm && this.currentVrm.expressionManager) {
      // Procedural Lip Sync (simple mouth opening/closing)
      const value = Math.abs(Math.sin(performance.now() * 0.015));
      this.currentVrm.expressionManager.setValue('aa', value);
    }
  }

  private resetMouth() {
    if (this.currentVrm && this.currentVrm.expressionManager) {
      this.currentVrm.expressionManager.setValue('aa', 0);
    }
  }
}
