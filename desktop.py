import os
import sys
import threading
import webbrowser
import time
import uvicorn
from main import app, monitor_heartbeat
import main

def start_browser():
    # Give the server a moment to start
    time.sleep(1.5)
    webbrowser.open("http://localhost:8001")

if __name__ == "__main__":
    # Enable desktop mode features (heartbeat monitoring)
    main.DESKTOP_MODE = True
    
    # Start the heartbeat monitor in a daemon thread
    t_monitor = threading.Thread(target=monitor_heartbeat, daemon=True)
    t_monitor.start()
    
    # Open the browser in a separate thread
    t_browser = threading.Thread(target=start_browser, daemon=True)
    t_browser.start()
    
    # Run the server
    uvicorn.run(app, host="0.0.0.0", port=8001)
