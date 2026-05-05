import os
import base64
import requests
from fastapi import FastAPI, HTTPException, Body
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import io
import nltk
import re
import json
import time
from typing import Any
import threading

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
MEMORY_PATH = "conversation_memory.json"
MAX_RECENT_TURNS = 12
MAX_FACTS = 24
SUMMARY_RECENT_TURNS = 6
SUMMARY_FACTS = 16
SUMMARY_COOLDOWN_SECONDS = 180
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.1:8b")

SUPPORTED_EMOTIONS = {
    "neutral",
    "happy",
    "sad",
    "angry",
    "surprised",
    "soft",
    "excited",
}

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
    emotion: str = "neutral"

class TTSRequest(BaseModel):
    gen_text: str
    target_lang: str = "ja" # Default to Japanese for Marin
    emotion: str | None = None


class MemoryTurn(BaseModel):
    user_message: str
    assistant_message: str


class MemoryStore:
    def __init__(self, path: str):
        self.path = path
        self._summary_lock = threading.Lock()

    def _default(self) -> dict[str, Any]:
        return {
            "facts": [],
            "recent_turns": [],
            "summary": "",
            "updated_at": 0,
            "last_summarized_at": 0,
        }

    def load(self) -> dict[str, Any]:
        if not os.path.exists(self.path):
            return self._default()
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                return self._default()
            data.setdefault("facts", [])
            data.setdefault("recent_turns", [])
            data.setdefault("summary", "")
            data.setdefault("updated_at", 0)
            data.setdefault("last_summarized_at", 0)
            return data
        except Exception:
            return self._default()

    def save(self, data: dict[str, Any]) -> None:
        data["updated_at"] = int(time.time())
        with open(self.path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

    def get_memory_payload(self) -> dict[str, Any]:
        data = self.load()
        return {
            "facts": data["facts"][:MAX_FACTS],
            "recent_turns": data["recent_turns"][-MAX_RECENT_TURNS:],
            "summary": data["summary"],
            "updated_at": data["updated_at"],
        }

    def clear(self) -> None:
        self.save(self._default())

    def add_turn(self, user_message: str, assistant_message: str) -> dict[str, Any]:
        data = self.load()
        timestamp = int(time.time())
        data["recent_turns"].extend([
            {"role": "user", "content": user_message.strip(), "timestamp": timestamp},
            {"role": "assistant", "content": assistant_message.strip(), "timestamp": timestamp},
        ])
        data["recent_turns"] = data["recent_turns"][-MAX_RECENT_TURNS:]

        for fact in extract_user_facts(user_message):
            self._upsert_fact(data["facts"], fact, timestamp)

        data["facts"] = data["facts"][:MAX_FACTS]
        self.save(data)
        self.maybe_schedule_summary()
        return self.get_memory_payload()

    def _upsert_fact(self, facts: list[dict[str, Any]], fact_text: str, timestamp: int) -> None:
        normalized = normalize_fact_text(fact_text)
        if not normalized:
            return

        for fact in facts:
            if normalize_fact_text(fact.get("text", "")) == normalized:
                fact["updated_at"] = timestamp
                return

        facts.insert(0, {
            "text": fact_text.strip(),
            "created_at": timestamp,
            "updated_at": timestamp,
        })

    def maybe_schedule_summary(self) -> None:
        data = self.load()
        now = int(time.time())
        should_summarize = (
            len(data["recent_turns"]) >= MAX_RECENT_TURNS
            or len(data["facts"]) >= 10
            or len(data.get("summary", "")) == 0
        )
        if not should_summarize:
            return
        if now - int(data.get("last_summarized_at", 0)) < SUMMARY_COOLDOWN_SECONDS:
            return
        if self._summary_lock.locked():
            return

        thread = threading.Thread(target=self._summarize_in_background, daemon=True)
        thread.start()

    def _summarize_in_background(self) -> None:
        if not self._summary_lock.acquire(blocking=False):
            return
        try:
            data = self.load()
            summary = summarize_memory_with_ollama(data)
            if not summary:
                return

            data["summary"] = summary
            data["last_summarized_at"] = int(time.time())
            data["recent_turns"] = data["recent_turns"][-SUMMARY_RECENT_TURNS:]
            data["facts"] = data["facts"][:SUMMARY_FACTS]
            self.save(data)
        finally:
            self._summary_lock.release()


memory_store = MemoryStore(MEMORY_PATH)


def normalize_fact_text(text: str) -> str:
    return " ".join(text.strip().lower().split())


def extract_user_facts(user_message: str) -> list[str]:
    facts: list[str] = []
    for raw_sentence in re.split(r"(?<=[.!?])\s+|\n+", user_message):
        sentence = raw_sentence.strip()
        if not sentence:
            continue

        lower = sentence.lower()
        patterns = (
            r"^my name is .+",
            r"^i am \d{1,3}\b.*",
            r"^i'm \d{1,3}\b.*",
            r"^i live in .+",
            r"^i am from .+",
            r"^i'm from .+",
            r"^i like .+",
            r"^i love .+",
            r"^i prefer .+",
            r"^my favorite .+",
            r"^my favourite .+",
            r"^i work as .+",
            r"^i work at .+",
            r"^i study .+",
            r"^i have .+",
            r"^my birthday is .+",
        )
        if any(re.match(pattern, lower) for pattern in patterns):
            facts.append(sentence)
    return facts


def summarize_memory_with_ollama(data: dict[str, Any]) -> str:
    facts = [fact.get("text", "").strip() for fact in data.get("facts", []) if fact.get("text")]
    turns = data.get("recent_turns", [])[-MAX_RECENT_TURNS:]
    existing_summary = data.get("summary", "").strip()

    turn_lines = []
    for turn in turns:
      role = turn.get("role", "user")
      content = turn.get("content", "").strip()
      if content:
          turn_lines.append(f"{role}: {content}")

    prompt_parts = [
        "Summarize this relationship memory for a roleplay assistant.",
        "Keep only durable user facts, preferences, ongoing situations, and important relationship context.",
        "Do not include filler, greetings, or one-off trivial details.",
        "Write 6 to 10 short bullet points.",
    ]
    if existing_summary:
        prompt_parts.append(f"Existing memory summary:\n{existing_summary}")
    if facts:
        prompt_parts.append("Saved facts:\n" + "\n".join(f"- {fact}" for fact in facts))
    if turn_lines:
        prompt_parts.append("Recent turns:\n" + "\n".join(turn_lines))

    payload = {
        "model": OLLAMA_MODEL,
        "messages": [
            {
                "role": "system",
                "content": "You compress conversation memory for another assistant. Return only concise bullet points."
            },
            {
                "role": "user",
                "content": "\n\n".join(prompt_parts)
            }
        ],
        "stream": False,
    }

    try:
        response = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=45)
        if response.status_code != 200:
            print(f"Memory summarization skipped, Ollama returned {response.status_code}")
            return ""
        data = response.json()
        content = data.get("message", {}).get("content", "").strip()
        return content[:2000]
    except Exception as error:
        print(f"Memory summarization failed: {error}")
        return ""


def normalize_emotion_name(emotion: str | None) -> str:
    if not emotion:
        return "neutral"
    normalized = emotion.strip().lower()
    return normalized if normalized in SUPPORTED_EMOTIONS else "neutral"


def get_reference_paths(emotion: str) -> tuple[str, str, str]:
    if emotion == "neutral":
        return REF_AUDIO_PATH, REF_TEXT_PATH, REF_LANG_PATH

    return (
        f"ref_audio_{emotion}.wav",
        f"ref_text_{emotion}.txt",
        f"ref_lang_{emotion}.txt",
    )


def extract_emotion_and_clean_text(text: str, fallback_emotion: str | None = None) -> tuple[str, str]:
    detected_emotion = normalize_emotion_name(fallback_emotion)
    cleaned = text

    def replace_tag(match: re.Match[str]) -> str:
        nonlocal detected_emotion
        tag = normalize_emotion_name(match.group(1))
        if tag in SUPPORTED_EMOTIONS:
            detected_emotion = tag
        return ""

    cleaned = re.sub(r"\[([a-zA-Z][a-zA-Z0-9_-]*)\]", replace_tag, cleaned)
    cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
    return detected_emotion, cleaned


@app.get("/memory")
async def get_memory():
    return memory_store.get_memory_payload()


@app.post("/memory/turn")
async def save_memory_turn(data: MemoryTurn):
    return memory_store.add_turn(data.user_message, data.assistant_message)


@app.post("/memory/clear")
async def clear_memory():
    memory_store.clear()
    return {"status": "success"}

@app.post("/set_voice")
async def set_voice(data: VoiceSetup):
    try:
        emotion = normalize_emotion_name(data.emotion)
        ref_audio_path, ref_text_path, ref_lang_path = get_reference_paths(emotion)
        audio_data = base64.b64decode(data.ref_audio_b64)
        # We save it locally so we can provide the path to GPT-SoVITS API
        # GPT-SoVITS API often expects a local path on the server machine.
        # Since this bridge runs on the same machine, we can use absolute paths.
        abs_audio_path = os.path.abspath(ref_audio_path)
        
        with open(abs_audio_path, "wb") as f:
            f.write(audio_data)
        with open(ref_text_path, "w", encoding="utf-8") as f:
            f.write(data.ref_text)
        with open(ref_lang_path, "w", encoding="utf-8") as f:
            f.write(data.ref_lang)
            
        return {
            "status": "success", 
            "message": "Voice reference saved.",
            "path": abs_audio_path,
            "emotion": emotion,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/has_voice")
async def has_voice():
    exists = os.path.exists(REF_AUDIO_PATH) and os.path.exists(REF_TEXT_PATH)
    return {"exists": exists}

@app.post("/tts")
async def tts(data: TTSRequest):
    emotion, cleaned_text = extract_emotion_and_clean_text(data.gen_text, data.emotion)
    ref_audio_path, ref_text_path, ref_lang_path = get_reference_paths(emotion)

    if not cleaned_text:
        raise HTTPException(status_code=400, detail="No text left to synthesize after removing emotion tags.")

    if not os.path.exists(ref_audio_path) or not os.path.exists(ref_text_path):
        if emotion != "neutral":
            ref_audio_path, ref_text_path, ref_lang_path = get_reference_paths("neutral")

    if not os.path.exists(ref_audio_path) or not os.path.exists(ref_text_path):
        raise HTTPException(status_code=400, detail="Voice not set. Please use /set_voice first.")

    try:
        with open(ref_text_path, "r", encoding="utf-8") as f:
            ref_text = f.read()
        
        ref_lang = "auto"
        if os.path.exists(ref_lang_path):
            with open(ref_lang_path, "r", encoding="utf-8") as f:
                ref_lang = f.read()

        # Prepare payload for official GPT-SoVITS api.py / api_v2.py
        # Note: Different versions of the API might use slightly different keys.
        # This follows the common api_v2.py structure.
        payload = {
            "text": cleaned_text,
            "text_lang": data.target_lang,
            "ref_audio_path": os.path.abspath(ref_audio_path),
            "prompt_text": ref_text,
            "prompt_lang": ref_lang,
            "top_k": 5,
            "top_p": 1,
            "temperature": 1,
            "speed_factor": 1.0,
            "streaming_mode": True,
            "parallel_infer": True,
            "text_split_method": "cut5"
        }

        print(f"Proxying TTS request to GPT-SoVITS at {GPT_SOVITS_URL} with emotion={emotion}...")
        
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
