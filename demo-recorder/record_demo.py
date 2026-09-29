"""
Report Test Buddy — Automated Demo Video Recorder

Records the screen while automating UI interactions following the demo script.
Produces a raw video, then burns subtitles using ffmpeg.

Usage:
  1. Run calibrate.py first to generate coords.json
  2. python record_demo.py
  3. Output: demo_final.mp4 (with subtitles)

Requirements: pip install -r requirements.txt
Also needs: ffmpeg in PATH (for subtitle burning)
"""

import json
import time
import threading
import subprocess
import sys
import os
from pathlib import Path

import cv2
import numpy as np
import pyautogui
import mss

pyautogui.FAILSAFE = True
pyautogui.PAUSE = 0.3

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
APP_URL = "http://localhost:8080"
FPS = 15
OUTPUT_RAW = "demo_raw.avi"
OUTPUT_FINAL = "demo_final.mp4"
SUBTITLE_FILE = os.path.join(os.path.dirname(__file__), "..", "demo-subtitles.srt")
COORDS_FILE = "coords.json"

# Sample data for the demo
SAMPLE_REPORT_NAME = "Sample Report"
SAMPLE_SCREEN_NAME = "Overview Screen"
SAMPLE_SCREEN_URL = "https://example.com/mstr/report/overview"
SAMPLE_REF_URL = "https://example.com/mstr/report/overview-qa"
SAMPLE_SCENARIO_NAME = "TRx Total – Overview Validation"
SAMPLE_DESCRIPTION = (
    "Load the Overview Screen at the main report URL and capture the displayed "
    "TRx Total value. Query the backend warehouse for the corresponding TRx Total "
    "figure using the same filters. Verify the two values match within an acceptable tolerance."
)


# ---------------------------------------------------------------------------
# Screen recorder (runs in background thread)
# ---------------------------------------------------------------------------
class ScreenRecorder:
    def __init__(self, output_path: str, fps: int = 15):
        self.output_path = output_path
        self.fps = fps
        self.recording = False
        self._thread = None
        self._sct = None

    def start(self):
        self.recording = True
        self._thread = threading.Thread(target=self._record_loop, daemon=True)
        self._thread.start()
        print(f"[recorder] Started recording at {self.fps} FPS → {self.output_path}")

    def stop(self):
        self.recording = False
        if self._thread:
            self._thread.join(timeout=5)
        print(f"[recorder] Stopped. Raw video saved to {self.output_path}")

    def _record_loop(self):
        with mss.mss() as sct:
            monitor = sct.monitors[1]
            w, h = monitor["width"], monitor["height"]
            fourcc = cv2.VideoWriter_fourcc(*"XVID")
            writer = cv2.VideoWriter(self.output_path, fourcc, self.fps, (w, h))
            interval = 1.0 / self.fps

            while self.recording:
                t0 = time.perf_counter()
                img = sct.grab(monitor)
                frame = np.array(img)
                frame = cv2.cvtColor(frame, cv2.COLOR_BGRA2BGR)
                writer.write(frame)
                elapsed = time.perf_counter() - t0
                if elapsed < interval:
                    time.sleep(interval - elapsed)

            writer.release()


# ---------------------------------------------------------------------------
# UI automation helpers
# ---------------------------------------------------------------------------
def load_coords() -> dict:
    if not os.path.exists(COORDS_FILE):
        print(f"[error] {COORDS_FILE} not found. Run calibrate.py first.")
        sys.exit(1)
    with open(COORDS_FILE) as f:
        return json.load(f)


def click(coords: dict, key: str, pause: float = 0.5):
    if key not in coords:
        print(f"  [skip] {key} not calibrated — skipping")
        time.sleep(pause)
        return False
    pos = coords[key]
    pyautogui.click(pos["x"], pos["y"])
    time.sleep(pause)
    return True


def click_and_type(coords: dict, key: str, text: str, pause: float = 0.5):
    if click(coords, key, pause=0.3):
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.1)
        pyautogui.typewrite(text, interval=0.03) if text.isascii() else pyautogui.write(text)
        time.sleep(pause)
        return True
    return False


def slow_type(text: str, interval: float = 0.04):
    for ch in text:
        pyautogui.press(ch) if len(ch) == 1 and ch.isascii() and ch.isprintable() else None
        if ch == " ":
            pyautogui.press("space")
        elif ch == "\n":
            pyautogui.press("enter")
        else:
            pyautogui.hotkey(ch) if not ch.isascii() else pyautogui.typewrite(ch, interval=0)
        time.sleep(interval)


def wait(seconds: float, label: str = ""):
    if label:
        print(f"  [wait] {label} ({seconds}s)")
    time.sleep(seconds)


def scroll_down(clicks: int = 3):
    pyautogui.scroll(-clicks)
    time.sleep(0.5)


# ---------------------------------------------------------------------------
# Demo scenario steps (matched to subtitle timings)
# ---------------------------------------------------------------------------
def run_demo(coords: dict):
    print("\n=== Starting Demo in 5 seconds — move mouse to a safe corner to abort ===\n")
    time.sleep(5)

    # ── Section 1: Intro — show dashboard (0:00 – 1:22)
    print("[00:00] Section 1: Dashboard overview")
    click(coords, "dashboard_tab", pause=2)
    wait(3, "Showing dashboard KPIs and run summary")
    scroll_down(2)
    wait(3, "Showing report summary by brand")
    scroll_down(-2)
    wait(2)

    # ── Section 2: Reports tab — add a report (1:23 – 3:24)
    print("[01:23] Section 2: Reports — adding a new report")
    click(coords, "reports_tab", pause=2)
    wait(1, "Reports list loaded")
    click(coords, "add_report_btn", pause=1.5)

    click_and_type(coords, "report_name_input", SAMPLE_REPORT_NAME, pause=1)
    click_and_type(coords, "screen_name_input", SAMPLE_SCREEN_NAME, pause=1)
    click_and_type(coords, "screen_url_input", SAMPLE_SCREEN_URL, pause=1)
    click_and_type(coords, "ref_url_input", SAMPLE_REF_URL, pause=1)

    click(coords, "main_cred_dropdown", pause=1)
    pyautogui.press("enter")
    wait(0.5)

    click(coords, "ref_cred_dropdown", pause=1)
    pyautogui.press("enter")
    wait(0.5)

    click(coords, "warehouse_cred_dropdown", pause=1)
    pyautogui.press("enter")
    wait(0.5)

    click(coords, "save_btn", pause=3)
    wait(2, "Report saved")

    # ── Section 3: Create scenario (3:28 – 5:25)
    print("[03:28] Section 3: Creating a test scenario")
    click(coords, "report_link", pause=2)

    click(coords, "generate_scenario_btn", pause=2)
    click_and_type(coords, "scenario_name_input", SAMPLE_SCENARIO_NAME, pause=1)

    click(coords, "scenario_type_dropdown", pause=1)
    click(coords, "warehouse_match_option", pause=1)

    click(coords, "criticality_dropdown", pause=1)
    click(coords, "medium_option", pause=1)

    click(coords, "add_scenario_btn", pause=3)
    wait(2, "Scenario created")

    # ── Section 4: Configure scenario — description, assertion, filters (5:25 – 9:02)
    print("[05:25] Section 4: Configuring scenario details")
    click(coords, "scenario_link", pause=3)

    if click(coords, "description_textarea", pause=0.5):
        pyautogui.hotkey("ctrl", "a")
        time.sleep(0.2)
        for word in SAMPLE_DESCRIPTION.split():
            pyautogui.typewrite(word + " ", interval=0.02)
            time.sleep(0.05)
        wait(2, "Description entered")

    click(coords, "assertion_dropdown", pause=1)
    pyautogui.press("enter")
    wait(1)

    click(coords, "add_filter_btn", pause=1.5)
    click_and_type(coords, "filter_area_input", "ALL", pause=0.5)
    click_and_type(coords, "filter_region_input", "ALL", pause=0.5)
    click_and_type(coords, "filter_territory_input", "ALL", pause=0.5)
    click_and_type(coords, "filter_time_bucket_input", "YTD", pause=0.5)
    click(coords, "save_filter_btn", pause=2)
    wait(2, "Filter combination saved")

    # ── Section 5: Generate and run script (9:02 – 10:14)
    print("[09:02] Section 5: Generate script and run")
    click(coords, "generate_script_btn", pause=5)
    wait(60, "Waiting for script generation (agent working)...")

    click(coords, "run_test_btn", pause=3)
    wait(60, "Waiting for test run to complete...")

    click(coords, "run_reference_btn", pause=3)
    wait(60, "Waiting for reference run to complete...")

    # ── Section 6: View results (10:14 – 10:57)
    print("[10:14] Section 6: Viewing results")
    click(coords, "latest_result_section", pause=3)
    wait(5, "Showing latest results — actual vs reference")

    # ── Section 7: Test Execution tab (10:42 – 11:24)
    print("[10:42] Section 7: Test Execution overview")
    click(coords, "test_execution_tab", pause=3)
    wait(3, "Test execution list loaded")

    click(coords, "passed_filter_btn", pause=3)
    wait(3, "Showing passed cases")

    click(coords, "failed_filter_btn", pause=3)
    wait(3, "Showing failed cases with diff")

    # ── Section 8: Runs and Admin (11:24 – 12:02)
    print("[11:24] Section 8: Runs and Admin")
    click(coords, "runs_tab", pause=3)
    wait(3, "Runs tab shown")

    click(coords, "settings_tab", pause=3)
    wait(5, "Settings / Admin shown")

    print("\n[done] Demo automation complete!")


# ---------------------------------------------------------------------------
# Post-processing: burn subtitles with ffmpeg
# ---------------------------------------------------------------------------
def burn_subtitles():
    srt_path = os.path.abspath(SUBTITLE_FILE)
    if not os.path.exists(srt_path):
        print(f"[warn] Subtitle file not found: {srt_path}")
        print("[warn] Skipping subtitle burn. Raw video is in", OUTPUT_RAW)
        return

    srt_escaped = srt_path.replace("\\", "/").replace(":", "\\:")
    cmd = [
        "ffmpeg", "-y",
        "-i", OUTPUT_RAW,
        "-vf", f"subtitles='{srt_escaped}':force_style='FontSize=22,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,Outline=2,Shadow=1,MarginV=40'",
        "-c:v", "libx264",
        "-preset", "fast",
        "-crf", "23",
        "-c:a", "copy",
        OUTPUT_FINAL,
    ]

    print(f"\n[ffmpeg] Burning subtitles into {OUTPUT_FINAL}...")
    try:
        subprocess.run(cmd, check=True)
        print(f"[ffmpeg] Done! Final video: {OUTPUT_FINAL}")
    except FileNotFoundError:
        print("[error] ffmpeg not found in PATH. Install it or add it to PATH.")
        print(f"[info] Raw video without subtitles: {OUTPUT_RAW}")
    except subprocess.CalledProcessError as e:
        print(f"[error] ffmpeg failed: {e}")
        print(f"[info] Raw video without subtitles: {OUTPUT_RAW}")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    print("=" * 60)
    print("  Report Test Buddy — Demo Video Recorder")
    print("=" * 60)

    coords = load_coords()
    print(f"Loaded {len(coords)} coordinates from {COORDS_FILE}")

    recorder = ScreenRecorder(OUTPUT_RAW, fps=FPS)
    recorder.start()

    try:
        run_demo(coords)
    except pyautogui.FailSafeException:
        print("\n[abort] Mouse moved to corner — failsafe triggered")
    except KeyboardInterrupt:
        print("\n[abort] Ctrl+C pressed")
    finally:
        wait(3, "Final pause before stopping recorder")
        recorder.stop()

    burn_subtitles()

    print("\n=== All done! ===")
    print(f"  Raw video:   {OUTPUT_RAW}")
    if os.path.exists(OUTPUT_FINAL):
        print(f"  Final video: {OUTPUT_FINAL}")


if __name__ == "__main__":
    main()
