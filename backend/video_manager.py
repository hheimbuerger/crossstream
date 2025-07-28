"""
Package for managing video playback sessions.

The `VideoManager` class is the core of CrossStream's video management. It handles all operations for a single video file.

The `SpriteBuilder` class is used to generate spritesheets for video segments. It is used by the `VideoManager` to generate spritesheets for the current video playback position.

The `TranscoderManager` class is used to manage video transcoding. It is used by the `VideoManager` to transcode the video file when necessary.
"""

import datetime
import json
import subprocess
import fractions
import time
from pathlib import Path
from typing import Dict, Any, List

class VideoManager:
    """Stateful video session manager that handles all operations for a single video file."""

    def __init__(self, media_dir: Path, cache_dir: Path, tools_dir: Path,
                 thumbnail_height: int = 90, seconds_per_thumbnail: float = 5.0,
                 force_timestamp: str = None):
        """Initialize the video manager.

        Args:
            media_dir: Directory containing media files
            cache_dir: Directory for cached files
            tools_dir: Directory containing FFmpeg tools
            thumbnail_height: Height of thumbnails in pixels
            seconds_per_thumbnail: Time interval between thumbnails
            force_timestamp: If set, extract timestamp from filename using pattern YYYY*MM*DD*HH*mm*SS
        """
        # Configuration
        self.media_dir = media_dir
        self.cache_dir = cache_dir
        self.tools_dir = tools_dir
        self.thumbnail_width = thumbnail_height * 16 // 9
        self.thumbnail_height = thumbnail_height
        self.seconds_per_thumbnail = seconds_per_thumbnail
        self.force_timestamp = force_timestamp

    def prepare_video(self):
        """Find the latest video and prepare it for playback.
        
        Performs heavy operations:
        - Finds/validates video file
        - Extracts metadata (duration, fps, etc.)
        - Generates thumbnail sprite if not cached
        """
        # Identify latest video by creation time
        self.video_path, self.timestamp = self.find_latest_video()

        # Extract metadata using integrated FFprobe functionality
        self._extract_metadata()

        # Generate thumbnail sprite if not cached
        self._ensure_thumbnail_sprite()

        print(f'Found and prepared video {self.video_path.name} (duration: {self.duration:.2f}s, fps: {float(self.fps):.2f}, chapters: {len(self.chapters)})')

    def find_latest_video(self) -> tuple[Path, datetime.datetime]:
        """Find and return the most recently created video file."""
        video_extensions = {'.mp4', '.mov', '.avi', '.mkv', '.wmv'}
        video_files = [
            f for f in self.media_dir.iterdir()
            if f.is_file() and f.suffix.lower() in video_extensions
        ]
        if not video_files:
            raise FileNotFoundError("No video files found in media directory")
        video_path = max(video_files, key=lambda f: f.stat().st_ctime)
        timestamp = self._get_file_creation_time(video_path)
        print(f'Most recently created video: {video_path.name} (created: {timestamp.isoformat()})')
        return video_path, timestamp

    def _extract_metadata(self) -> None:
        """Extract comprehensive metadata from the video."""
        self.duration, self.fps, self.chapters = self._probe_video()

    def _ensure_thumbnail_sprite(self) -> None:
        """Ensure thumbnail sprite exists, generate if needed."""
        self.thumbnail_sprite_path = self.cache_dir / f"{self.video_path.stem}.thumbnail.jpeg"

        if not self.thumbnail_sprite_path.exists():
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            self._build_thumbnail_sprite()
            print(f'Generated thumbnail sprite: {self.thumbnail_sprite_path.relative_to(Path.cwd())}')
        else:
            print(f'Using cached thumbnail sprite: {self.thumbnail_sprite_path.relative_to(Path.cwd())}')

    def _build_thumbnail_sprite(self) -> None:
        """Build thumbnail sprite using integrated FFmpeg functionality."""
        frame_interval = self.seconds_per_thumbnail * self.fps
        frame_count = int(self.duration * self.fps)
        num_tiles = int(frame_count // frame_interval)

        debug_arguments = (
            '-hide_banner', '-loglevel', 'info', '-stats',
        )
        ffmpeg_path = self.tools_dir / 'ffmpeg'
        arguments = (
            '-hwaccel', 'nvdec',
            '-discard', 'nokey',
            '-skip_frame', 'nokey',
            '-i', str(self.video_path),
            '-filter:v', f"fps=1/{self.seconds_per_thumbnail},scale={self.thumbnail_width}:{self.thumbnail_height},tile={num_tiles}x1",
            '-frames:v', '1',
            '-qscale:v', '3',
            '-vsync', '0',
            '-an',
            '-y',
            str(self.thumbnail_sprite_path)
        )

        print(f'Building thumbnail sprite:')
        timer = time.perf_counter()
        results = subprocess.run((ffmpeg_path,) + debug_arguments + arguments, capture_output=True, check=True)
        print(f'  ffmpeg time: {time.perf_counter() - timer:.2f}s')

    def _run_ffprobe(self, *arguments) -> bytes:
        """Run ffprobe with given arguments and return stdout."""
        ffprobe_path = self.tools_dir / "ffprobe"
        result = subprocess.run((ffprobe_path,) + arguments, capture_output=True, check=True)
        return result.stdout

    def _probe_video(self) -> tuple[float, fractions.Fraction, List[Dict[str, Any]]]:
        """Extract duration, fps, and chapters from the loaded video using JSON output."""
        timer = time.perf_counter()
        print(f'Probing video metadata:')
        result = self._run_ffprobe(
            "-v", "error",
            "-print_format", "json",
            "-select_streams", "v",
            "-show_entries", "format=duration:stream=r_frame_rate",
            "-show_chapters",
            str(self.video_path)
        )

        try:
            data = json.loads(result.decode('utf-8'))
        except json.JSONDecodeError as e:
            # If JSON parsing fails, the output is likely an error message
            error_output = result.decode('utf-8', errors='replace')
            raise RuntimeError(f'ffprobe returned invalid JSON. Error output: {error_output}')

        # Extract duration from format
        duration = float(data['format']['duration'])

        # Extract fps from streams
        r_frame_rate = data['streams'][0]['r_frame_rate']
        numerator, denominator = r_frame_rate.split('/')
        fps = fractions.Fraction(numerator=int(numerator), denominator=int(denominator))

        # Extract chapters (only id, start_time, end_time, title)
        chapters = []
        for chapter in data.get('chapters', []):
            chapter_info = {
                'id': chapter['id'],
                'start_time': float(chapter['start_time']),
                'end_time': float(chapter['end_time']),
                'title': chapter.get('tags', {}).get('title', f'Chapter {chapter["id"] + 1}')
            }
            chapters.append(chapter_info)

        print(f'  ffprobe time: {time.perf_counter() - timer:.2f}s')

        return duration, fps, chapters

    def _extract_timestamp_from_filename(self, filename: str) -> datetime.datetime:
        """Extract timestamp from filename using pattern YYYY*MM*DD*HH*mm*SS.
        
        Args:
            filename: The filename to extract timestamp from
            
        Returns:
            datetime: Extracted timestamp in local timezone
            
        Raises:
            ValueError: If timestamp cannot be extracted from filename
        """
        import re
        # Match YYYY*MM*DD*HH*mm*SS where * is any non-digit (or nothing)
        match = re.search(
            r'(\d{4})[^\d]?(\d{2})[^\d]?(\d{2})[^\d]{0,3}(\d{2})[^\d]?(\d{2})[^\d]?(\d{2})',
            filename
        )
        if not match:
            raise ValueError(f"Could not extract timestamp from filename: {filename}")
            
        year, month, day, hour, minute, second = map(int, match.groups())
        
        # Create a timezone-aware datetime in local timezone
        return datetime.datetime(
            year=year, month=month, day=day,
            hour=hour, minute=minute, second=second
        ).astimezone()

    def _get_file_creation_time(self, filepath: Path) -> datetime.datetime:
        """Get file creation time.
        
        If force_timestamp is set, extracts timestamp from filename.
        Otherwise, uses the filesystem creation time.
        """
        if self.force_timestamp is not None:
            try:
                return self._extract_timestamp_from_filename(filepath.name)
            except ValueError as e:
                print(f"Warning: {e}. Falling back to filesystem creation time.")
        
        # Fall back to filesystem timestamp
        creation_time = filepath.stat().st_ctime
        return datetime.datetime.fromtimestamp(creation_time, datetime.timezone.utc).astimezone()
