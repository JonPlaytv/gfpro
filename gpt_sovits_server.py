import os
import base64
import requests
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import io
import nltk

# Ensure necessary NLTK resources are available
try:
    nltk.data.find('taggers/averaged_perceptron_tagger_eng')
except LookupError:
    print("Downloading missing NLTK resource: averaged_perceptron_tagger_eng...")
    nltk.download('averaged_perceptron_tagger_eng')
try:
    nltk.data.find('tokenizers/punkt')
except LookupError:
    print("Downloading missing NLTK resource: punkt...")
    nltk.download('punkt')
try:
    nltk.data.find('tokenizers/punkt_tab')
except LookupError:
    print("Downloading missing NLTK resource: punkt_tab...")
    nltk.download('punkt_tab')

# Ensure fast-langdetect cache directory exists (required by the library)
fast_langdetect_cache = os.path.join(os.environ.get('LOCALAPPDATA', os.path.expanduser('~')), 'Temp', 'fasttext-langdetect')
if not os.path.exists(fast_langdetect_cache):
    try:
        os.makedirs(fast_langdetect_cache, exist_ok=True)
    except Exception as e:
        print(f"Warning: Could not create fast-langdetect cache directory: {e}")

# Configuration
# Point this to your running GPT-SoVITS API server (default is 9880)
GPT_SOVITS_URL = os.environ.get("GPT_SOVITS_URL", "http://localhost:9880")

REF_AUDIO_PATH = "ref_audio.wav"
REF_TEXT_PATH = "ref_text.txt"
REF_LANG_PATH = "ref_lang.txt"

app = FastAPI(title="GPT-SoVITS Bridge Server")

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
    ref_lang: str = "auto" # zh, en, ja, ko, etc.

class TTSRequest(BaseModel):
    gen_text: str
    target_lang: str = "ja" # Default to Japanese for Marin

@app.post("/set_voice")
async def set_voice(data: VoiceSetup):
    try:
        audio_data = base64.b64decode(data.ref_audio_b64)
        # We save it locally so we can provide the path to GPT-SoVITS API
        # GPT-SoVITS API often expects a local path on the server machine.
        # Since this bridge runs on the same machine, we can use absolute paths.
        abs_audio_path = os.path.abspath(REF_AUDIO_PATH)
        
        with open(abs_audio_path, "wb") as f:
            f.write(audio_data)
        with open(REF_TEXT_PATH, "w", encoding="utf-8") as f:
            f.write(data.ref_text)
        with open(REF_LANG_PATH, "w", encoding="utf-8") as f:
            f.write(data.ref_lang)
            
        return {
            "status": "success", 
            "message": "Voice reference saved.",
            "path": abs_audio_path
        }
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
        
        ref_lang = "auto"
        if os.path.exists(REF_LANG_PATH):
            with open(REF_LANG_PATH, "r", encoding="utf-8") as f:
                ref_lang = f.read()

        # Prepare payload for official GPT-SoVITS api.py / api_v2.py
        # Note: Different versions of the API might use slightly different keys.
        # This follows the common api_v2.py structure.
        payload = {
            "text": data.gen_text,
            "text_lang": data.target_lang,
            "ref_audio_path": os.path.abspath(REF_AUDIO_PATH),
            "prompt_text": ref_text,
            "prompt_lang": ref_lang,
            "top_k": 5,
            "top_p": 1,
            "temperature": 1,
            "speed_factor": 1.0
        }

        print(f"Proxying TTS request to GPT-SoVITS at {GPT_SOVITS_URL}...")
        
        # We use GET or POST depending on the version, but api_v2.py usually supports POST /tts
        # Some versions use a simple GET with query params. Let's try POST first.
        response = requests.post(f"{GPT_SOVITS_URL}/tts", json=payload, stream=True)
        
        if response.status_code != 200:
            # Try fallback to GET if POST fails (older versions)
            print("POST failed, trying GET fallback...")
            response = requests.get(f"{GPT_SOVITS_URL}/tts", params=payload, stream=True)

        if response.status_code != 200:
            detail = response.text
            print(f"GPT-SoVITS Error: {detail}")
            raise HTTPException(status_code=response.status_code, detail=f"GPT-SoVITS error: {detail}")

        return StreamingResponse(response.iter_content(chunk_size=8192), media_type="audio/wav")

    except requests.exceptions.ConnectionError:
        error_msg = f"Could not connect to GPT-SoVITS at {GPT_SOVITS_URL}. Make sure the GPT-SoVITS API server is running on port 9880."
        print(f"ERROR: {error_msg}")
        raise HTTPException(
            status_code=503, 
            detail=error_msg
        )
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # Start on 8000 to maintain compatibility with the frontend
    uvicorn.run(app, host="0.0.0.0", port=8000)
