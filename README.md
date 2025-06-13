# CrossStream

Synchronized side-by-side video player for instant collaborative review of concurrent screen recordings

## ✨ Features

- **Real-time Synchronization**: Keep multiple video players in sync across different devices
- **Peer-to-Peer Architecture**: Direct connection between participants for low-latency communication
- **Bidirectional Control**: Any participant can control playback (play/pause/seek) with changes reflected for all

## 🚀 Getting Started

### Prerequisites

- Python 3.8 or later
- UV (Python package manager)
- FFmpeg with FFprobe (must be in system PATH or in the `tools/` directory)
- Modern web browser with WebRTC support (Chrome, Firefox, Edge, or Safari)

### Installation

1. **Clone the repository**:
   ```bash
   git clone https://github.com/your-username/crossstream.git
   cd crossstream
   ```

2. **Install UV** (if not already installed):
   ```bash
   pip install uv
   ```

3. **Set up video files**:
   - Create a `test_videos` directory in the project root
   - Add your screen recordings in the format: `Hunt YYYY-MM-DD HH-MM-SS.mkv`
   - Place related recordings in separate subdirectories (e.g., `test_videos/3a/` and `test_videos/3b/`)

4. **Run the application**:
   - Open two terminal windows
   - In the first terminal, run the host instance:
     ```bash
     run_h.cmd
     ```
   - In the second terminal, run the client instance:
     ```bash
     run_s.cmd
     ```
   - The application will automatically open in your default web browser

5. **Access the player**:
   - The player interface will be available at `http://localhost:6001` (host) and `http://localhost:7001` (client)
   - Use the player controls to synchronize playback between the two instances

## 🛠 Architecture

CrossStream is built with a modular architecture:

- **Frontend**: Modern JavaScript with a clean UI layer
- **Synchronization Engine**: Handles real-time state management between peers
- **Event Bus**: Manages communication between components
- **Video Player Synchronizer**: Keeps video players in sync within a single browser instance

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with ❤️ for seamless video watching experiences
- Thanks to all contributors who have helped improve CrossStream
