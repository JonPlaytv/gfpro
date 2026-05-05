import './style.css';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, VRM } from '@pixiv/three-vrm';
import { AnimationManager } from './animation';
import { VoiceManager } from './voice';
import { recordingBlobToWavBase64 } from './audioExport';


// Create Loading Overlay
const overlay = document.createElement('div');
overlay.className = 'loading-overlay';
overlay.innerHTML = `
  <div class="spinner"></div>
  <div class="loading-text">Waking up AI Partner...</div>
  <div class="progress-container">
    <div id="progress-bar" class="progress-bar"></div>
  </div>
  <div id="progress-percentage" class="progress-percentage">0%</div>
`;
document.getElementById('app')?.appendChild(overlay);

const progressBar = document.getElementById('progress-bar') as HTMLDivElement;
const progressPercentage = document.getElementById('progress-percentage') as HTMLDivElement;
const loadingText = overlay.querySelector('.loading-text') as HTMLDivElement;

// --- Scene Setup ---
const canvas = document.getElementById('vrm-canvas') as HTMLCanvasElement;
const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
// Use sRGB encoding for realistic colors (in newer three.js it's outputColorSpace)
renderer.outputColorSpace = THREE.SRGBColorSpace;

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0.0, 1.4, 2.0); // Center roughly on a humanoid character's upper body

const controls = new OrbitControls(camera, renderer.domElement);
controls.screenSpacePanning = true;
controls.target.set(0.0, 1.4, 0.0);
controls.update();

// --- Lighting ---
const light = new THREE.DirectionalLight(0xffffff, Math.PI);
light.position.set(1.0, 1.0, 1.0).normalize();
scene.add(light);

const ambientLight = new THREE.AmbientLight(0xffffff, 0.5); // Add soft ambient light
scene.add(ambientLight);

// --- Managers ---
const animationManager = new AnimationManager();
const voiceManager = new VoiceManager();

// --- VRM Setup ---
let currentVrm: VRM | undefined;


const loader = new GLTFLoader();

// Install GLTFLoader plugin for VRM
loader.register((parser) => {
  return new VRMLoaderPlugin(parser);
});

const vrmUrl = '/3950292976901405976.vrm'; // Fetched from public directory

loader.load(
  vrmUrl,
  (gltf) => {
    const vrm = gltf.userData.vrm as VRM;
    if (vrm) {
      // Calling these functions greatly improves the VRM rendering
      VRMUtils.removeUnnecessaryVertices(gltf.scene);
      VRMUtils.removeUnnecessaryJoints(gltf.scene);

      scene.add(vrm.scene);
      currentVrm = vrm;

      // Fix rotation if character faces backwards
      vrm.scene.rotation.y = Math.PI;

      // Initialize managers
      animationManager.setVrm(vrm);
      voiceManager.setVrm(vrm);

      // Hide loading overlay
      overlay.classList.add('hidden');
      setTimeout(() => overlay.remove(), 500);

      console.log('VRM loaded successfully!');
    }
  },
  (progress) => {
    const percent = Math.floor(100.0 * (progress.loaded / progress.total));
    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressPercentage) progressPercentage.innerText = `${percent}%`;

    if (percent >= 100 && loadingText) {
      loadingText.innerText = 'Initializing...';
    }
    console.log('Loading model...', percent, '%');
  },
  (error) => {
    console.error('An error happened loading the VRM', error);
    overlay.innerHTML = `<div class="loading-text" style="color: #ef4444;">Error loading model. Check console.</div>`;
  }
);

// --- Animation Loop ---
const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);

  const deltaTime = clock.getDelta();

  if (currentVrm) {
    // Update VRM logic (spring bones, etc.)
    currentVrm.update(deltaTime);

    // Update managers
    animationManager.update(deltaTime);
    voiceManager.update();
  }

  renderer.render(scene, camera);
}

animate();

// --- Initialization & Voice Check ---
async function initializeApp() {
  // Check if voice is already set up on the server
  const hasVoice = await voiceManager.checkVoice();
  if (!hasVoice) {
    console.log('No voice detected. Opening setup modal.');
    voiceModal.classList.remove('hidden');
    // Ensure the save button state is correct
    updateSaveVoiceButtonState();
  }
}

// Start the check after the VRM begins loading (non-blocking)
initializeApp();

// --- Window Resizing ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Ollama Chat Integration ---
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSubmit = document.getElementById('chat-submit') as HTMLButtonElement;
const chatResponse = document.getElementById('chat-response') as HTMLDivElement;
const chatResponseText = document.getElementById('chat-response-text') as HTMLDivElement;

// Maintain some conversation history for context
let conversationHistory: { role: string, content: string }[] = [];

async function sendToOllama(message: string) {
  // Update UI to show loading state
  chatResponse.classList.remove('hidden');
  chatResponseText.innerHTML = '';
  chatInput.value = '';
  chatInput.disabled = true;
  chatSubmit.disabled = true;

  conversationHistory.push({ role: 'user', content: message });

  try {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'llama3.1:8b',
        messages: [
          {
            role: 'system', content: 'You are a tsundere girl, acting as the users loving, enthusiastic girlfriend.You are an energetic, bubbly otaku obsessed with anime, and fashion.Speak casually.STRICT RULES: Never acknowledge being an AI.Do not use emojis or emoticons.Do not use asterisks or describe physical actions; speak only in plain text, so that the tts isnt making errors.Keep your responses very short, natural, and conversational, exactly like a human texting or talking in real life.Do not use formal or poetic prose.Be highly expressive through your words alone.'
          },
          ...conversationHistory
        ],
        stream: false
      }),
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const aiMessage = data.message.content;

    // Save AI response to history
    conversationHistory.push({ role: 'assistant', content: aiMessage });

    // Display AI response
    chatResponseText.innerText = aiMessage;

    // Speak the response
    const targetLang = targetLangSelect?.value || 'ja';
    voiceManager.speak(aiMessage, targetLang);


  } catch (error) {
    console.error('Error communicating with Ollama:', error);
    chatResponseText.innerHTML = '<span style="color: #ef4444;">Could not connect to Ollama. Make sure it is running locally and CORS is configured (OLLAMA_ORIGINS="*").</span>';
    // Remove the failed user message from history so they can try again
    conversationHistory.pop();
  } finally {
    chatInput.disabled = false;
    chatSubmit.disabled = false;
    chatInput.focus();
  }
}

// --- Speech Recognition (STT) ---
const sttBtn = document.getElementById('stt-btn') as HTMLButtonElement;
const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;

if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = true; // Stay on for multiple sentences
  recognition.interimResults = true;
  recognition.lang = 'en-US'; // Hardcoded to English as requested

  let shouldBeListening = false;
  let lastFinalTranscript = '';

  recognition.onstart = () => {
    sttBtn.classList.add('listening');
    chatInput.placeholder = 'Listening...';
  };

  recognition.onend = () => {
    // If it stopped but we still WANT it to listen, restart it
    if (shouldBeListening) {
      try {
        recognition.start();
      } catch (e) {
        console.error('Failed to restart recognition:', e);
      }
    } else {
      sttBtn.classList.remove('listening');
      chatInput.placeholder = 'Talk to your AI Partner...';
    }
  };

  recognition.onresult = (event: any) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript;
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    if (finalTranscript) {
      chatInput.value = finalTranscript.trim();
      // Only send if it's new content
      if (chatInput.value !== lastFinalTranscript) {
        lastFinalTranscript = chatInput.value;
        setTimeout(() => {
          if (chatInput.value.trim()) {
            sendToOllama(chatInput.value.trim());
            chatInput.value = ''; // Clear input for next sentence
          }
        }, 300);
      }
    } else if (interimTranscript) {
      chatInput.value = interimTranscript;
    }
  };

  recognition.onerror = (event: any) => {
    console.error('Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      shouldBeListening = false;
      sttBtn.classList.remove('listening');
    }
  };

  sttBtn.addEventListener('click', () => {
    if (shouldBeListening) {
      shouldBeListening = false;
      recognition.stop();
    } else {
      shouldBeListening = true;
      lastFinalTranscript = '';
      recognition.start();
    }
  });
} else {
  sttBtn.style.display = 'none';
  console.warn('Speech recognition not supported in this browser.');
}

// Event Listeners for Chat
chatSubmit.addEventListener('click', () => {
  const message = chatInput.value.trim();
  if (message) {
    sendToOllama(message);
  }
});

chatInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    const message = chatInput.value.trim();
    if (message) {
      sendToOllama(message);
    }
  }
});

// --- Voice Setup Logic ---
const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
const voiceModal = document.getElementById('voice-setup-modal') as HTMLDivElement;
const recordBtn = document.getElementById('record-btn') as HTMLButtonElement;
const stopRecordBtn = document.getElementById('stop-record-btn') as HTMLButtonElement;
const audioUpload = document.getElementById('audio-upload') as HTMLInputElement;
const uploadStatus = document.getElementById('upload-status') as HTMLSpanElement;
const saveVoiceBtn = document.getElementById('save-voice-btn') as HTMLButtonElement;
const refTextInput = document.getElementById('ref-text') as HTMLTextAreaElement;
const recordingStatus = document.getElementById('recording-status') as HTMLSpanElement;
const refLangSelect = document.getElementById('ref-lang') as HTMLSelectElement;
const targetLangSelect = document.getElementById('target-lang') as HTMLSelectElement;

let mediaRecorder: MediaRecorder | null = null;
let recordStream: MediaStream | null = null;
let audioChunks: Blob[] = [];
let selectedAudioBase64: string | null = null;
let isConvertingRecording = false;

function updateSaveVoiceButtonState(): void {
  if (!saveVoiceBtn) return;
  const hasText = refTextInput.value.trim().length > 0;
  const hasAudio = selectedAudioBase64 !== null;
  saveVoiceBtn.disabled = !(hasText && hasAudio && !isConvertingRecording);
}

// Clicks inside the card must not hit the backdrop close handler by mistake
document.querySelector('.modal-content')?.addEventListener('click', (e) => {
  e.stopPropagation();
});

// Toggle Modal via Settings Button
settingsBtn?.addEventListener('click', () => {
  voiceModal.classList.toggle('hidden');
  if (!voiceModal.classList.contains('hidden')) {
    updateSaveVoiceButtonState();
  }
});

// Close modal when clicking outside (optional but nice)
voiceModal?.addEventListener('click', (e) => {
  if (e.target === voiceModal) {
    voiceModal.classList.add('hidden');
  }
});

refTextInput?.addEventListener('input', () => {
  updateSaveVoiceButtonState();
});

// Option 1: Recording
recordBtn?.addEventListener('click', async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordStream = stream;
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];
    selectedAudioBase64 = null; // Clear any previous upload
    updateSaveVoiceButtonState();

    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };

    mediaRecorder.onstop = async () => {
      isConvertingRecording = true;
      updateSaveVoiceButtonState();
      recordingStatus.innerText = 'Converting to WAV...';
      recordBtn.classList.remove('hidden');
      stopRecordBtn.classList.add('hidden');

      try {
        const mime = mediaRecorder?.mimeType || 'audio/webm';
        const blob = new Blob(audioChunks, { type: mime });
        selectedAudioBase64 = await recordingBlobToWavBase64(blob);
        recordingStatus.innerText = 'Recording ready! You can save now.';
        uploadStatus.innerText = '';
      } catch (err) {
        console.error('Failed to convert recording:', err);
        selectedAudioBase64 = null;
        recordingStatus.innerText = '';
        alert('Could not convert the recording to WAV. Try a shorter clip or upload a .wav file.');
      } finally {
        isConvertingRecording = false;
        recordStream?.getTracks().forEach((t) => t.stop());
        recordStream = null;
        updateSaveVoiceButtonState();
      }
    };

    mediaRecorder.start();
    recordingStatus.innerText = 'Recording...';
    recordBtn.classList.add('hidden');
    stopRecordBtn.classList.remove('hidden');
  } catch (err) {
    console.error('Error starting recording:', err);
    alert('Could not access microphone.');
  }
});

stopRecordBtn?.addEventListener('click', () => {
  mediaRecorder?.stop();
});

// Option 2: Upload
audioUpload?.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) {
    const reader = new FileReader();
    reader.onloadend = () => {
      selectedAudioBase64 = (reader.result as string).split(',')[1];
      uploadStatus.innerText = `File selected: ${file.name}`;
      recordingStatus.innerText = ''; // Clear recording status
      audioChunks = []; // Clear recording chunks
      updateSaveVoiceButtonState();
    };
    reader.readAsDataURL(file);
  }
});

// Save Logic
saveVoiceBtn?.addEventListener('click', async () => {
  const transcript = refTextInput.value.trim();

  if (isConvertingRecording) {
    alert('Please wait until conversion finishes (status shows Recording ready).');
    return;
  }
  if (!selectedAudioBase64) {
    alert('Please record audio or upload a file first.');
    return;
  }
  if (!transcript) {
    alert('Please enter the exact transcript of your clip.');
    return;
  }

  saveVoiceBtn.disabled = true;
  saveVoiceBtn.innerText = 'Saving...';
  const refLang = refLangSelect?.value || 'ja';
  const success = await voiceManager.setVoice(selectedAudioBase64, transcript, refLang);
  saveVoiceBtn.innerText = 'Save Voice';
  updateSaveVoiceButtonState();

  if (success) {
    const ok = await voiceManager.checkVoice();
    voiceModal.classList.add('hidden');
    alert(ok ? 'Voice saved on the server. You can chat now.' : 'Save reported OK but server has no voice files yet.');
  } else {
    alert('Failed to save voice. Start gpt_sovits_server.py on http://localhost:8000 and try again.');
  }
});

// Check voice on load removed to prevent auto-opening
// checkVoiceSetup();

