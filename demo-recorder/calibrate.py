"""
Step 1: Run this script FIRST to capture click coordinates for demo steps.
Move your mouse to each UI element and press ENTER to record its position.
Press 'q' to quit. Saves coordinates to coords.json.
"""
import pyautogui
import json
import time

STEPS = [
    ("app_url_bar", "Position your mouse on the browser URL bar (to type localhost:8080)"),
    ("dashboard_tab", "Position on the Dashboard / Home tab"),
    ("reports_tab", "Position on the Reports tab (left sidebar)"),
    ("add_report_btn", "Position on the 'Add Report' button"),
    ("report_name_input", "Position on the Report Name input field"),
    ("screen_name_input", "Position on the Screen Name input field"),
    ("screen_url_input", "Position on the Screen URL input field"),
    ("ref_url_input", "Position on the Reference URL input field"),
    ("main_cred_dropdown", "Position on the Main Credential dropdown"),
    ("ref_cred_dropdown", "Position on the Reference Credential dropdown"),
    ("warehouse_cred_dropdown", "Position on the Warehouse Credential dropdown"),
    ("save_btn", "Position on the Save button"),
    ("report_link", "Position on the report name link (to open it)"),
    ("generate_scenario_btn", "Position on the 'Generate Scenario' or 'Add Scenario' button"),
    ("scenario_name_input", "Position on the Scenario Name input field"),
    ("scenario_type_dropdown", "Position on the Type dropdown (Warehouse Match, etc.)"),
    ("warehouse_match_option", "Position on the 'Warehouse Match' option"),
    ("reference_match_option", "Position on the 'Reference Match' option"),
    ("criticality_dropdown", "Position on the Criticality dropdown"),
    ("medium_option", "Position on the 'Medium' option"),
    ("add_scenario_btn", "Position on the Add / Create button for scenario"),
    ("scenario_link", "Position on the created scenario link (to open it)"),
    ("description_textarea", "Position on the Description textarea"),
    ("assertion_dropdown", "Position on the assertion operator dropdown"),
    ("add_filter_btn", "Position on the 'Add Filter Combination' button"),
    ("filter_area_input", "Position on the Area filter input"),
    ("filter_region_input", "Position on the Region filter input"),
    ("filter_territory_input", "Position on the Territory filter input"),
    ("filter_time_bucket_input", "Position on the Time Bucket filter input"),
    ("save_filter_btn", "Position on the Save filter button"),
    ("generate_script_btn", "Position on the 'Generate Script' button"),
    ("run_test_btn", "Position on the 'Run Test' / 'Test Headless' button"),
    ("run_reference_btn", "Position on the 'Run Reference' button"),
    ("latest_result_section", "Position on the Latest Result section"),
    ("test_execution_tab", "Position on the Test Execution tab"),
    ("passed_filter_btn", "Position on the 'Passed' filter button"),
    ("failed_filter_btn", "Position on the 'Failed' filter button"),
    ("runs_tab", "Position on the Runs tab"),
    ("settings_tab", "Position on the Settings / Admin tab"),
]

def main():
    coords = {}
    print("\n=== Report Test Buddy Demo — Coordinate Calibrator ===")
    print("For each step, move your mouse to the UI element and press ENTER.")
    print("Type 's' to skip a step, 'q' to quit and save.\n")

    for key, instruction in STEPS:
        print(f"\n[{key}]")
        print(f"  >> {instruction}")
        choice = input("  Press ENTER to capture, 's' to skip, 'q' to quit: ").strip().lower()
        if choice == "q":
            break
        if choice == "s":
            print(f"  Skipped {key}")
            continue
        time.sleep(0.3)
        x, y = pyautogui.position()
        coords[key] = {"x": x, "y": y}
        print(f"  Captured: ({x}, {y})")

    out_path = "coords.json"
    with open(out_path, "w") as f:
        json.dump(coords, f, indent=2)
    print(f"\nSaved {len(coords)} coordinates to {out_path}")
    print("Next: review coords.json, then run record_demo.py")

if __name__ == "__main__":
    main()
