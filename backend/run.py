"""Single-click Windows startup: server, optional floating cat, and browser."""
import os
from pathlib import Path
import subprocess
import sys
import threading
import webbrowser
import uvicorn


def start_floating_cat():
    if sys.platform != "win32" or os.environ.get("ERGO_FLOATING_CAT") == "0":
        return None
    pythonw = Path(sys.executable).with_name("pythonw.exe")
    executable = pythonw if pythonw.is_file() else Path(sys.executable)
    options = {"stdin": subprocess.DEVNULL, "stdout": subprocess.DEVNULL,
               "stderr": subprocess.DEVNULL, "cwd": str(Path(__file__).resolve().parent.parent)}
    if not pythonw.is_file():
        options["creationflags"] = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        child = subprocess.Popen([str(executable), str(Path(__file__).with_name("desktop_guard.py"))], **options)
        print("姿勢ねこの小窓を起動しました（作業操作は止まりません）。")
        return child
    except OSError as error:
        print(f"姿勢ねこの起動に失敗しました: {error}")
        return None


if __name__ == "__main__":
    cat = start_floating_cat()
    threading.Timer(1.5, lambda: webbrowser.open("http://localhost:8000")).start()
    try:
        uvicorn.run("main:app", host="0.0.0.0", port=8000)
    finally:
        if cat and cat.poll() is None:
            cat.terminate()
            try:
                cat.wait(timeout=3)
            except subprocess.TimeoutExpired:
                pass
