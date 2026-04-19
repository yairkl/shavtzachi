import os
import subprocess
import sys

def main():
    root_dir = os.path.dirname(os.path.abspath(__file__))
    frontend_dir = os.path.join(root_dir, "frontend")
    
    print("--- Building Frontend ---")
    npm_cmd = "npm.cmd" if os.name == "nt" else "npm"
    
    try:
        print("Running npm install...")
        subprocess.check_call([npm_cmd, "install"], cwd=frontend_dir)
        print("Running npm run build...")
        subprocess.check_call([npm_cmd, "run", "build"], cwd=frontend_dir)
    except subprocess.CalledProcessError as e:
        print(f"Error building frontend: {e}")
        sys.exit(1)
        
    print("--- Installing Backend Dependencies ---")
    try:
        if os.path.exists(os.path.join(root_dir, "requirements.txt")):
             subprocess.check_call([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"])
        subprocess.check_call([sys.executable, "-m", "pip", "install", "pyinstaller"])
    except subprocess.CalledProcessError as e:
        print(f"Error installing dependencies: {e}")
        sys.exit(1)

    print("--- Packaging with PyInstaller ---")
    dist_dir = os.path.join(frontend_dir, "dist")
    if not os.path.exists(dist_dir):
        print(f"Error: Frontend build directory not found at {dist_dir}")
        sys.exit(1)

    sep = ";" if os.name == "nt" else ":"
    add_data_arg = f"{dist_dir}{sep}frontend/dist"
    
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--name", "shavtzachi",
        "--onefile",
        "--add-data", add_data_arg,
        "main.py"
    ]
    
    try:
        subprocess.check_call(cmd, cwd=root_dir)
    except subprocess.CalledProcessError as e:
        print(f"Error running PyInstaller: {e}")
        sys.exit(1)
        
    print("\n==================================")
    print("✅ Build completed successfully!")
    executable_ext = ".exe" if os.name == "nt" else ""
    print(f"Your standalone application is located at: dist/shavtzachi{executable_ext}")
    print("You can distribute this single file to non-technical users.")
    print("==================================")

if __name__ == "__main__":
    main()
