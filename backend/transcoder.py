import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional


class TranscoderManager:
    """Manages the transcoder process lifecycle."""
    
    def __init__(self, tools_dir: Path, media_dir: Path, transcoder_port: int,
                 executable_name: str,
                 config_template: str = 'config.yaml.template', stop_timeout: float = 5.0):
        self.executable_name = Path(executable_name)
        self.tools_dir = tools_dir
        self.media_dir = media_dir
        self.transcoder_port = transcoder_port
        self.config_template = tools_dir / config_template
        self.process: Optional[subprocess.Popen] = None
        self.stop_timeout = stop_timeout

    def start(self) -> None:
        """Start the transcoder process with proper signal handling."""
        config_file = self.media_dir / 'transcode' / 'config.yaml'
        
        # Ensure directories exist
        config_file.parent.mkdir(parents=True, exist_ok=True)
        
        # Read and format config
        with open(self.config_template, 'r') as f:
            config = f.read().format(
                media_dir=self.media_dir.resolve(),
                transcoder_port=self.transcoder_port
            )
            with open(config_file, 'w') as out:
                out.write(config)
        
        # Set up process creation flags for Windows
        creation_flags = 0
        if os.name == 'nt':
            creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
        
        # Start the transcoder process without capturing output
        transcode_cmd = [
            self.tools_dir / self.executable_name,
            'serve',
            '--config', config_file.resolve(),
        ]
        
        print(f"Starting transcoder with command: {' '.join(str(c) for c in transcode_cmd)}")
        
        self.process = subprocess.Popen(
            [str(c) for c in transcode_cmd],
            cwd=str(self.tools_dir),
            shell=False,
            creationflags=creation_flags
        )
        
        # Verify the process started
        time.sleep(1)  # Give it a moment to start
        if self.process.poll() is not None:
            print(f"Error: Transcoder process failed to start. Exit code: {self.process.returncode}")
            sys.exit(1)
        
        print(f"Transcoder process started with PID {self.process.pid}")

    def stop(self) -> None:
        """Gracefully stop the transcoder process."""
        if not self.process:
            return

        try:
            print("\nShutting down transcoder gracefully...")
            if os.name == 'nt':  # Windows
                self.process.send_signal(signal.CTRL_BREAK_EVENT)
            else:  # Unix-like
                self.process.terminate()
            
            # Wait for process to terminate
            try:
                self.process.wait(timeout=self.stop_timeout)
                print("Transcoder process terminated successfully")
            except subprocess.TimeoutExpired:
                print("Process didn't terminate gracefully, forcing...")
                self.process.kill()
                self.process.wait()
                print("Transcoder process force terminated")
                
        except Exception as e:
            print(f"Error during process shutdown: {e}")
            if self.process.poll() is None:
                print("Forcing process termination...")
                self.process.kill()
                self.process.wait()
        finally:
            self.process = None
