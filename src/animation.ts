import * as THREE from 'three';
import { VRM } from '@pixiv/three-vrm';

export class AnimationManager {
  private mixer: THREE.AnimationMixer | null = null;
  private currentVrm: VRM | null = null;

  constructor() {}

  public setVrm(vrm: VRM) {
    this.currentVrm = vrm;

    this.mixer = new THREE.AnimationMixer(vrm.scene);
    console.log('AnimationManager: VRM set', vrm);
    
    // Set a default pose to break T-pose
    const leftUpperArm = vrm.humanoid?.getNormalizedBoneNode('leftUpperArm');
    const rightUpperArm = vrm.humanoid?.getNormalizedBoneNode('rightUpperArm');
    if (leftUpperArm) leftUpperArm.rotation.z = Math.PI / 4;
    if (rightUpperArm) rightUpperArm.rotation.z = -Math.PI / 4;
  }


  public update(deltaTime: number) {
    if (this.mixer) {
      this.mixer.update(deltaTime);
    }

    // Procedural Breathing/Idle if no animation is playing
    if (this.currentVrm && (!this.mixer || !this.mixer.stats.actions)) {
      this.applyProceduralIdle(performance.now() / 1000);
    }
  }

  private applyProceduralIdle(time: number) {
    if (!this.currentVrm) return;

    // Subtle breathing - chest expansion
    const chest = this.currentVrm.humanoid?.getNormalizedBoneNode('chest');
    if (chest) {
      const breathe = Math.sin(time * 1.5) * 0.02;
      chest.rotation.x = breathe;
    } else {
      if (time < 5) console.warn('AnimationManager: Chest bone not found');
    }

    // Subtle swaying
    const spine = this.currentVrm.humanoid?.getNormalizedBoneNode('spine');
    if (spine) {
      const sway = Math.sin(time * 0.5) * 0.01;
      spine.rotation.z = sway;
    }


    // Blink logic
    const blink = Math.max(0, Math.sin(time * 0.3) > 0.98 ? 1 : 0);
    if (this.currentVrm.expressionManager) {
      this.currentVrm.expressionManager.setValue('blink', blink);
    }
  }

  public playAnimation(clip: THREE.AnimationClip) {
    if (!this.mixer) return;
    this.mixer.stopAllAction();
    const action = this.mixer.clipAction(clip);
    action.play();
  }
}
