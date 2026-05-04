import os
import base64
import numpy as np
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import io
import wave
import torch
from f5_tts.model import DiT
from f5_tts.infer.utils_infer import load_model, load_vocoder, infer_process
from huggingface_hub import hf_hub_download
from contextlib import asynccontextmanager

# Configuration
# Default F5-TTS Base Model Config
model_cfg = dict(dim=1024, depth=22, heads=16, ff_mult=2, text_dim=512, conv_layers=4)
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
REF_AUDIO_PATH = "ref_audio.wav"
REF_TEXT_PATH = "ref_text.txt"

# Global model state
ema_model = None
vocoder = None

def init_model():
    global ema_model, vocoder
    if ema_model is None:
        print(f"Loading F5-TTS model on {DEVICE}...")
        try:
            # Download checkpoint from HuggingFace
            ckpt_path = hf_hub_download(repo_id="SWivid/F5-TTS", filename="F5TTS_Base/model_1200000.safetensors")
            
            # Load model using the correct signature:
            # load_model(model_cls, model_cfg, ckpt_path, mel_spec_type="vocos", vocab_file="", device=device)
            ema_model = load_model(
                model_cls=DiT,
                model_cfg=model_cfg,
                ckpt_path=ckpt_path,
                device=DEVICE
            )
            vocoder = load_vocoder()
            print(f"Model loaded successfully from {ckpt_path}")
        except Exception as e:
            print(f"Error loading model: {e}")
            import traceback
            traceback.print_exc()
            raise e

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup
    init_model()
    yield
    # Shutdown (optional)

app = FastAPI(lifespan=lifespan)

# Enable CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

class VoiceSetup(BaseModel):
    ref_audio_b64: str
    ref_text: str

class TTSRequest(BaseModel):
    gen_text: str

@app.post("/set_voice")
async def set_voice(data: VoiceSetup):
    try:
        audio_data = base64.b64decode(data.ref_audio_b64)
        with open(REF_AUDIO_PATH, "wb") as f:
            f.write(audio_data)
        with open(REF_TEXT_PATH, "w", encoding="utf-8") as f:
            f.write(data.ref_text)
        return {"status": "success", "message": "Voice reference saved."}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/has_voice")
async def has_voice():
    exists = os.path.exists(REF_AUDIO_PATH) and os.path.exists(REF_TEXT_PATH)
    return {"exists": exists}

@app.post("/tts")
async def tts(data: TTSRequest):
    if not os.path.exists(REF_AUDIO_PATH) or not os.path.exists(REF_TEXT_PATH):
        raise HTTPException(status_code=400, detail="Voice not set. Please use /set_voice first.")

    try:
        with open(REF_TEXT_PATH, "r", encoding="utf-8") as f:
            ref_text = f.read()

        # Perform inference
        audio, sr = infer_process(
            REF_AUDIO_PATH,
            ref_text,
            data.gen_text,
            ema_model,
            vocoder,
            device=DEVICE
        )

        # Convert numpy array to WAV
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(sr)
            wav_file.writeframes((audio * 32767).astype(np.int16).tobytes())
        
        buf.seek(0)
        return StreamingResponse(buf, media_type="audio/wav")

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
