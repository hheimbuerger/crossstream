import subprocess
import fractions
import time
from pathlib import Path
from typing import Optional

class SpriteBuilder:
    """
    Synchronously builds thumbnail sprites for videos.
    """
    def __init__(self, tools_dir: Path):
        self.tools_dir = tools_dir

    def build_thumbnail_sprite(self, input, output, seconds_per_thumbnail, thumbnail_width, thumbnail_height):
        """
        Build a thumbnail sprite synchronously for the given video.
        """
        duration, fps = self._probe_video(input)
        frame_interval = seconds_per_thumbnail * fps
        frame_count = int(duration * fps)
        num_tiles = int(frame_count // frame_interval)
        debug_arguments = (
            '-hide_banner', '-loglevel', 'info', '-stats',
        )
        ffmpeg_path = self.tools_dir / 'ffmpeg'
        arguments = (
            '-hwaccel', 'nvdec',
            '-discard', 'nokey',
            '-skip_frame', 'nokey',
            '-i', input,
            '-filter:v', f"fps=1/{seconds_per_thumbnail},scale={thumbnail_width}:{thumbnail_height},tile={num_tiles}x1",
            '-frames:v', '1',
            '-qscale:v', '3',
            '-vsync', '0',
            '-an',
            '-y',
            output
        )
        timer = time.perf_counter()
        results = subprocess.run((ffmpeg_path,) + debug_arguments + arguments, capture_output=True)
        print(f'  ffmpeg time: {time.perf_counter() - timer:.2f}s')
        if results.returncode != 0:
            raise RuntimeError(f'Error running ffmpeg: {results.stderr}')
        return True

    def _run_ffprobe(self, *arguments):
        ffprobe_path = self.tools_dir / "ffprobe"
        result = subprocess.run((ffprobe_path,) + arguments, capture_output=True)
        return result.stdout

    def _determine_parameters(self, filename, parameters):
        timer = time.perf_counter()
        result = self._run_ffprobe(
            "-v", "error",
            "-select_streams", "v",
            "-show_entries", parameters,
            "-of", "default=noprint_wrappers=1:nokey=0",
            filename
        ).decode('ascii').strip()
        print(f'  ffprobe time: {time.perf_counter() - timer:.2f}s')
        return {pair.split('=')[0].strip(): pair.split('=')[1].strip() for pair in result.split('\n')}

    def _probe_video(self, filename):
        keyvals = self._determine_parameters(filename, "format=duration:stream=r_frame_rate")
        duration = float(keyvals['duration'])
        numerator, denominator = keyvals['r_frame_rate'].split('/')
        fps = fractions.Fraction(numerator=int(numerator),
                                denominator=int(denominator))
        print(f'  duration: {duration}, fps: {fps}')
        return duration, fps

    def _build_thumbnail_sprite(self, input, output, seconds_per_thumbnail, thumbnail_width, thumbnail_height):
        duration, fps = self._probe_video(input)
        frame_interval = seconds_per_thumbnail * fps
        frame_count = int(duration * fps)
        num_tiles = int(frame_count // frame_interval)
        debug_arguments = (
            '-hide_banner', '-loglevel', 'info', '-stats',
        )
        ffmpeg_path = self.tools_dir / 'ffmpeg'
        arguments = (
            '-hwaccel', 'nvdec',
            '-discard', 'nokey',
            '-skip_frame', 'nokey',
            '-i', input,
            '-filter:v', f"fps=1/{seconds_per_thumbnail},scale={thumbnail_width}:{thumbnail_height},tile={num_tiles}x1",
            '-frames:v', '1',
            '-qscale:v', '3',
            '-vsync', '0',
            '-an',
            '-y',
            output
        )
        timer = time.perf_counter()
        results = subprocess.run((ffmpeg_path,) + debug_arguments + arguments, capture_output=True)
        print(f'  ffmpeg time: {time.perf_counter() - timer:.2f}s')
        if results.returncode != 0:
            raise RuntimeError(f'Error running ffmpeg: {results.stderr}')
        return True
