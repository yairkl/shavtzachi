# Shavtzachi (שבצחי) - Automated Tactical Scheduler

Shavtzachi is an automated, constraints-based personnel shift scheduler. Designed to eliminate the manual, error-prone process of assigning individuals to shifts, the system natively handles skills, cooldowns, exclusions, and predictive future rest periods using tailored optimization algorithms (both Optimal and Greedy assignment mechanisms).

![Shavtzachi](https://img.shields.io/badge/Status-Production_Ready-brightgreen)
![Tech Stack](https://img.shields.io/badge/Stack-React%20%7C%20FastAPI%20%7C%20SQLite%20%2F%20GSheets-blue)

---

## 🌟 Key Features

- **Automated Scheduling Engines:** Assign personnel intelligently via optimal algorithm approaches or greedy algorithms, configurable on the fly.
- **Advanced Constraint Tracking:** Hard constraints (e.g. strict cooldown hours, temporary post activations, specific post exclusions) and soft constraints (e.g. fair rest, mission diversity) are fully supported.
- **Real-Time Conflict Detection:** Identify rule violations instantly in the UI during Draft Mode before finalizing a schedule.
- **Dynamic Personnel Profiling:** Attach specialized skills (Roles), track past workload intensity scores, and manage temporary unavailabilities/leave.
- **Export Capabilities:** Export robust and color-coded final schedules seamlessly into Excel files, and bulk import/export configurations (Posts & Soldiers) via CSV.
- **Multi-Backend Support:** Choice between local SQLite database (for offline use) or Google Sheets backend (for collaborative, cloud-synced management).
- **Desktop Flow:** Build a single-executable native application that opens in your system browser and automatically shuts down when you're done.

---

## 🚀 Tech Stack

- **Backend:** Python + FastAPI 
- **Database:** SQLite3 or Google Sheets API
- **Scheduling Engines:** Custom algorithms leveraging combinatorial rules and history heuristics.
- **Frontend:** React + Vite, TailwindCSS, Shadcn-UI (Radix) styled components.

---

## 💻 Development Instructions

If you are modifying code, you will likely want to run the application dynamically in development mode.

### 1. Backend Setup
Make sure you have Python 3.9+ installed natively.
```bash
# Move to the root directory
cd shavtzachi

# (Optional) Create and start a virtual environment
python -m venv .venv

# On Linux/macOS
source .venv/bin/activate
# On Windows
.venv\Scripts\activate

# Install requirements
pip install -r requirements.txt
```

### 2. Frontend Setup
Make sure you have Node.js (and NPM) installed.
```bash
cd frontend
npm install
```

### 3. Running Dev Servers
Run both systems concurrently in separate terminal windows:
```bash
# Terminal 1 - Backend Server
uvicorn main:app --host 0.0.0.0 --port 8001 --reload

# Terminal 2 - Frontend Server
cd frontend
npm run dev
```

---

## 📥 Installation for Non-Technical Users (End-Users)

If you just want to use the application without dealing with code, you do not need to install Python or Node.js. 

1. **Go to the Releases Page:** Visit the [Releases page](https://github.com/yairkl/shavtzachi/releases) of this repository.
2. **Download the App:** Download the latest version of the executable file (e.g., `shavtzachi-windows.exe` for Windows).
3. **Run the App:** Move the downloaded file into a dedicated folder. Double-click the file to open it. 
   - *Note:* A web browser will automatically open the application.
   - *Auto-Shutdown:* To close the application, simply close the browser tab. The background process will automatically shut down after a few seconds.
4. **Data Management:**
   - **SQLite Mode:** A `data.db` file will be created next to the executable. **Do not delete this file**.
   - **GSheets Mode:** If configured, the app will sync directly with your Google Spreadsheet.

---

## 📦 Production Build Instructions (For Developers)

You can compile the entire application (React Web App + FastAPI Backend + Database engine) into a **single, portable, executable file** to distribute to non-technical users via GitHub Releases.

### Building
Open a terminal in the root directory (make sure your python virtual environment with `pyinstaller` installed is activated).
```bash
python build.py
```
**What does this script do?**
1. Installs frontend `npm` dependencies.
2. Builds the minified static React application.
3. Installs backend `pip` dependencies.
4. Generates a standalone OS-specific binary using PyInstaller.

> **Note:** Compiling to a Windows `.exe` requires running `build.py` natively on a Windows machine. Compiling on Linux produces a Linux executable.

### Running the Standalone Application
1. Navigate to the newly created `dist/` directory.
2. Double-click the generated file (`shavtzachi` or `shavtzachi.exe`).
3. The server will silently start up, and your default web browser will automatically open to the scheduling application!

### Warning Concerning Data Retention
When running the standalone executable, all constraints, personnel, and schedule data are actively saved to a local `data.db` file. **This file will be created in the current working directory next to the executable.** Ensure users know not to delete this file, or they will lose their schedule!

---

## 🗃️ Application Architecture Snippet

- `models.py`: Central declarative schema for relational tracking.
- `database.py`: Unified database entry point that handles backend selection (SQLite vs. GSheets).
- `database_gsheets.py`: Implementation of the Google Sheets backend.
- `schedule.py`: Contains the constraint-evaluator rulesets and shift deployment algorithms.
- `desktop.py`: Entry point for the release build; manages browser opening and heartbeat-based auto-shutdown.
- `build.py`: CI script that compiles PyInstaller builds with bundled configuration.
