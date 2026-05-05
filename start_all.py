import subprocess
import time
import sys
import os
import signal
import urllib.request
import urllib.error

def start_process(command, cwd=None, name="Process"):
    print(f"Starting {name}...")
    # Ensure command is a string for shell=True
    if isinstance(command, list):
        command = " ".join(command)
    return subprocess.Popen(command, cwd=cwd, shell=True)

def is_http_ready(url, timeout=2):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            return 200 <= response.status < 500
    except Exception:
        return False

def kill_process_tree(p):
    """
    Kills the process and all its children.
    This is especially important on Windows when using shell=True.
    """
    if p.poll() is None: # If still running
        try:
            if os.name == 'nt':
                # /F = force, /T = tree (children), /PID = process id
                subprocess.run(['taskkill', '/F', '/T', '/PID', str(p.pid)], 
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            else:
                # Linux/Mac equivalent
                os.killpg(os.getpgid(p.pid), signal.SIGTERM)
        except Exception as e:
            print(f"Error killing process {p.pid}: {e}")
            p.terminate()

def main():
    processes = []
    shutting_down = False
    
    def shutdown():
        nonlocal shutting_down
        if shutting_down:
            return
        shutting_down = True
        print("\n" + "="*50)
        print("STOPPING ALL PROCESSES...")
        print("="*50)
        for p in processes:
            kill_process_tree(p)
        print("All systems stopped. Goodbye!\n")
        sys.exit(0)

    # Handle signals for non-interactive shutdown
    signal.signal(signal.SIGINT, lambda s, f: shutdown())
    signal.signal(signal.SIGTERM, lambda s, f: shutdown())

    try:
        # 1. Start Ollama if needed
        if is_http_ready("http://localhost:11434/api/tags"):
            print("Ollama is already running.")
        else:
            processes.append(start_process("ollama serve", name="Ollama"))
            time.sleep(3)

        # 2. Start GPT-SoVITS API if needed
        sovits_dir = os.path.join(os.getcwd(), "GPT-SoVITS-v3lora-20250228", "GPT-SoVITS-v3lora-20250228")
        python_exe = f'"{sys.executable}"'
        if is_http_ready("http://localhost:9880"):
            print("GPT-SoVITS API is already running.")
        else:
            processes.append(start_process([python_exe, "api_v2.py"], cwd=sovits_dir, name="GPT-SoVITS API"))
        
        # Give it a moment to start
        time.sleep(5)
        
        # 3. Start Bridge Server if needed
        if is_http_ready("http://localhost:8000/has_voice"):
            print("Bridge Server is already running.")
        else:
            processes.append(start_process([python_exe, "gpt_sovits_server.py"], name="Bridge Server"))
        
        # 4. Start Frontend (Vite)
        npm_cmd = "cmd /c npm run dev" if os.name == 'nt' else "npm run dev"
        processes.append(start_process(npm_cmd, name="Vite Frontend"))
        
        print("\n" + "="*50)
        print("ALL SYSTEMS STARTED")
        print("1. Ollama Chat API (Port 11434)")
        print("2. GPT-SoVITS API (Port 9880)")
        print("3. Bridge Server with memory + emotion routing (Port 8000)")
        print("4. Vite Frontend (Check console for URL)")
        print("="*50)
        print("\nPress Ctrl+C to stop all.\n")
        
        # Monitor processes
        while True:
            for p in processes:
                if p.poll() is not None:
                    # If a process died, we should probably stop everything to be safe
                    # and allow the user to see the error.
                    print(f"\n[!] WARNING: A process has exited (Code: {p.returncode}).")
                    shutdown()
            time.sleep(2)
            
    except KeyboardInterrupt:
        shutdown()
    except Exception as e:
        print(f"An unexpected error occurred: {e}")
        shutdown()

if __name__ == "__main__":
    main()
