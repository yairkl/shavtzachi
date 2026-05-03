import os
import sys
import threading
import webbrowser
import time
import uvicorn
from main import app, monitor_heartbeat
import main
import socket

def start_browser():
    """Polls the server port until it's active before opening the browser."""
    url = "http://localhost:8001"
    print(f"Browser thread: Waiting for server at {url}...")
    
    # Poll for up to 30 seconds
    start_time = time.time()
    while time.time() - start_time < 30:
        try:
            # Try to connect to the server port
            with socket.create_connection(("127.0.0.1", 8001), timeout=0.5):
                print("Browser thread: Server is up! Opening browser.")
                webbrowser.open(url)
                return
        except (OSError, ConnectionRefusedError):
            time.sleep(0.5)
    
    print("Browser thread: Timeout waiting for server. Attempting to open browser anyway.")
    webbrowser.open(url)

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
