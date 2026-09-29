# Agentic Frontend Validations — Demo script (short)

Each part is **under 3 minutes**. Play the matching audio while you click.

| Part | Topic | Audio | Length |
|------|--------|--------|--------|
| 1 | What the tool is, and the pages | [`docs/demo-audio/part-1-intro.mp3`](demo-audio/part-1-intro.mp3) | 1:59 |
| 2 | Add report, case, generate script | [`docs/demo-audio/part-2-configure.mp3`](demo-audio/part-2-configure.mp3) | 2:03 |
| 3 | Run tests and see the summary | [`docs/demo-audio/part-3-execute.mp3`](demo-audio/part-3-execute.mp3) | 2:02 |

**Voice:** Microsoft Zira (clear US English). Microsoft Jenny neural voice is blocked on this VDI.  
**Words:** Report = Athena report. Screen = one page. Scenario = one test case.

Play the MP3, then click along. Pause the video if generate or a run takes longer than the voice.

---

# PART 1 — Intro and pages  
**Audio:** `docs/demo-audio/part-1-intro.mp3` (1:59)

### What to click

1. Open the app. Stay on **Dashboard**. Show the logo.
2. Point to the **four boxes**: Total scenarios → Cases ran → Passed → Failed.
3. Open one report under **By report**. Show a screen row.
4. Hover the left menu: Dashboard, Screens, Tests execution status, Runs, SQL templates, Settings.
5. Open **Screens** for a second, then go back to Dashboard.

### What the voice says

This is Agentic Frontend Validations. We use it to validate Athena reports.

It can do three kinds of checks.

First: front-end report versus front-end report. That is prod versus pre-prod. Same Athena report, two environments. Do the numbers match?

Second: cross-screen front-end validation. Compare one Athena screen with another, for example Overview versus Activity.

Third: front-end report versus the backend database. We read the tiles or grid on the report, then compare those numbers to the warehouse table.

The tool opens the Athena report, reads the numbers, compares them, and shows pass or fail.

The left menu is the whole tool.

Dashboard is the home page. At the top you now see four boxes: total scenarios, how many cases ran, how many passed, and how many failed. So first we see what exists, then what we have run, then the result.

Below, results are grouped by Athena report. Open a report and you see each screen.

Screens is where we add the Athena report and each page.

Tests execution status shows the latest result of every case. Runs is the history of every run.

SQL templates hold the database queries for report versus backend.

If you are an admin, Settings holds Athena login and the database connection. We set that once. We will not type passwords in this video.

Next, we will add a report, add a case, and generate the script.

---

# PART 2 — Configure and generate  
**Audio:** `docs/demo-audio/part-2-configure.mp3` (2:03)

### What to click

1. **Screens** → **Add screen**.
2. Pick or create the Athena **Report**. Name the **Screen**. Paste **Screen URL**.
3. If prod vs pre-prod or screen vs screen: add **Reference URL**.
4. Pick **Screen Login Credentials**. Optionally warehouse + SQL. **Save**.
5. Open the screen. Add a test case (Warehouse or Reference).
6. Write the description. Add a **filter combination**.
7. **Test script** → **Generate**. Wait. Then **Save**.

### What the voice says

Part two. We configure the case.

On Screens, click Add screen. Pick or create the Athena report. Name the screen the way people say it, like Overview. Paste the Screen URL. That is the page the tool will open.

If this is prod versus pre-prod, or one screen versus another, add a Reference URL. That is the second front-end report.

Pick the saved Athena login. If this case will check the database, attach the warehouse and SQL template. Then save.

Open the screen and add a test case.

Warehouse type means front-end versus the backend table.

Reference type means front-end versus front-end: prod versus pre-prod, or screen versus screen.

Write a short description of what you see on the Athena page: which page, which tiles or grid, which filters. Do not add extra pages.

Add filter combinations. The script runs once for each filter set, so one case can cover many areas.

Then open Test script and click Generate.

The tool writes the browser steps: open the report, log in, apply filters, and read the numbers. Then it tries the script for real. If something fails, it tries to fix it, up to five times.

When it passes, the script is saved.

For a database case, bind the SQL template. For prod versus pre-prod, generate the reference script, or sync from main and swap the URL. Use the same KPI names on both sides.

Next, we run it and look at the summary.

---

# PART 3 — Run and summary  
**Audio:** `docs/demo-audio/part-3-execute.mp3` (2:02)

### What to click

1. Point at **Run report**, **Run suite**, and **Run headless**.
2. Click **Run suite**. Open the new run.
3. Show passed / failed / pending. Open one case (expected vs actual).
4. Optional: one case → **Run headless** → **Latest result**.
5. Open **Runs**. Then go back to **Dashboard** and point at the four boxes again.

### What the voice says

Part three. We run the tests and read the summary.

You can run the whole Athena report, one screen, or one case.

Run report runs every page. Run suite runs every case on this screen. Run headless runs only this case.

I will run this screen. A run starts right away. Results appear as each case finishes.

This is the live summary. The top line is the score: passed, failed, and still pending.

Open a case. You see expected versus actual. That is either Athena prod versus pre-prod, one screen versus another, or Athena numbers versus the database table.

If it failed, you see why, and often a screenshot.

To run one case only, open the case and click Run headless. Latest result is the summary for that case.

The Runs page is the list you share with the team. Each row shows the report, how many passed, how many failed, and when.

Back on Dashboard, the four boxes tell the story: total cases, how many ran, how many passed, and how many failed. Click Cases ran to see only cases that already have a result.

Green means the numbers match. Red means they do not.

To recap: this tool validates Athena reports. Front-end versus front-end. Screen versus screen. Or report versus the backend table.

Part one, the pages. Part two, configure and generate. Part three, run and read pass or fail.

That's Agentic Frontend Validations.

---

## How to record

1. Open the app. Close extra tabs. Zoom about 110%.
2. Play `part-1-intro.mp3` and click along. Stop recording when the voice ends.
3. Do the same for Part 2 and Part 3.
4. If **Generate** or a run is still going when the voice ends, pause the video, wait, then continue. Do not stretch the voice past 3 minutes.
5. Do not type passwords on camera.

## Make the audio again

From the project folder, play or remake the WAV files in `docs/demo-audio/`.  
To try the Jenny neural voice later (needs a network that allows Edge speech): `py docs/demo-audio/generate_audio.py`
