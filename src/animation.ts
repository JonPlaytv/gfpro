import * as THREE from 'three';
import { VRM } from '@pixiv/three-vrm';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRMAnimationLoaderPlugin, createVRMAnimationClip } from '@pixiv/three-vrm-animation';

export class AnimationManager {
    private mixer: THREE.AnimationMixer | null = null;
    private currentVrm: VRM | null = null;
    private idleAction: THREE.AnimationAction | null = null;

    constructor() {}

    public setVrm(vrm: VRM, onReady?: () => void) {
        this.currentVrm = vrm;
        this.mixer = new THREE.AnimationMixer(vrm.scene);

        vrm.scene.visible = false;
        this.loadIdleAnimation('/Idle.vrma', onReady);
    }

    private loadIdleAnimation(url: string, onReady?: () => void) {
        const loader = new GLTFLoader();
        loader.register((parser) => new VRMAnimationLoaderPlugin(parser));

        loader.load(
            url,
            (gltf) => {
                const vrmAnimations = (gltf.userData.vrmAnimations as unknown[]) || [];
                const vrmAnimation = vrmAnimations[0];

                if (vrmAnimation && this.mixer && this.currentVrm) {
                    const clip = createVRMAnimationClip(vrmAnimation as never, this.currentVrm);
                    this.idleAction = this.mixer.clipAction(clip);
                    this.idleAction.reset();
                    this.idleAction.setLoop(THREE.LoopRepeat, Infinity);
                    this.idleAction.play();
                    console.log('AnimationManager: Loaded VRMA clip', clip.name || '(unnamed)', 'Duration:', clip.duration);
                } else {
                    console.warn('AnimationManager: No VRM animation found in VRMA');
                }

                if (this.currentVrm) {
                    this.currentVrm.scene.visible = true;
                    console.log('AnimationManager: Live Sync Ready');
                }

                if (onReady) onReady();
            },
            undefined,
            (error) => {
                console.error('AnimationManager: Failed to load VRMA animation', error);

                if (this.currentVrm) {
                    this.currentVrm.scene.visible = true;
                }

                if (onReady) onReady();
            }
        );
    }

    public update(deltaTime: number) {
        if (this.mixer) {
            this.mixer.update(deltaTime);
        }

        if (this.currentVrm) {
            this.applyProceduralBlink(performance.now() / 1000);
        }
    }

    private applyProceduralBlink(time: number) {
        if (!this.currentVrm) return;

        const blink = Math.max(0, Math.sin(time * 0.3) > 0.98 ? 1 : 0);
        if (this.currentVrm.expressionManager) {
            this.currentVrm.expressionManager.setValue('blink', blink);
        }
    }

    public playAnimation(clip: THREE.AnimationClip) {
        if (!this.mixer) return;

        this.mixer.stopAllAction();
        const action = this.mixer.clipAction(clip);
        action.reset();
        action.play();
    }
}
