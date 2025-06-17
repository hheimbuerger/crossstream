#!/usr/bin/env python3
"""benchmark_ffmpeg.py

Simple benchmark runner for FFmpeg encoder configurations.

Usage::

    python benchmark_ffmpeg.py input.mp4 \
        "-c:v h264_nvenc -preset p1 -b:v 4M" \
        "-c:v h264_nvenc -preset p4 -b:v 6M" 

The script will run FFmpeg once per configuration, applying the
segment-oriented flags that the go-transcode project uses and
printing a coloured table with elapsed time per run.

Bonus: prints GPU name if *nvidia-smi* is available.
"""

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time
import glob
from typing import List

# Optional coloured output --------------------------------------------------
try:
    from colorama import Fore, Style, init as colorama_init

    colorama_init(autoreset=True)
    GREEN = Fore.GREEN
    YELLOW = Fore.YELLOW
    CYAN = Fore.CYAN
    RESET = Style.RESET_ALL
except ImportError:
    GREEN = YELLOW = CYAN = RESET = ""

# ---------------------------------------------------------------------------

def gpu_name() -> str:
    """Return first GPU name found via nvidia-smi, or empty string."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"],
            stderr=subprocess.DEVNULL,
            text=True,
        ).strip()
        return out.split("\n")[0] if out else ""
    except (FileNotFoundError, subprocess.CalledProcessError):
        return ""


SEGMENT_LENGTH = 4  # seconds
DEFAULT_NUM_SEGMENTS = 10
START_OFFSET_SEC = 300  # begin benchmark 5 minutes into the video

# Define encoder configurations here.
# Each entry is a (label, pre_input_args, post_input_args)
ENCODER_CONFIGS = [
    (
        "CPU (stock go-transcode config)",
        "",
        "-c:v libx264 -preset veryfast -profile:v high -crf 23 -c:a aac -b:a 192k",
    ),
    (
        "CPU (ultrafast preset)",
        "",
        "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -c:a aac -b:a 192k",
    ),
    (
        "CPU (stock, but audio removed)",
        "",
        "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -an",
    ),
    (
        "CPU (stock, audio copied)",
        "",
        "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -c:a copy",
    ),
    (
        "CPU (stock, opus audio)",
        "",
        "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -c:a libopus -preset veryfast -b:a 128k",
    ),
    (
        "NVENC (config recommendation I found in 2022)",
        "",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    ),
    (
        "NVENC (with hardware decoding)",
        "-hwaccel nvdec -hwaccel_device 0",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    ),
    (
        "NVENC (threads 2, no idea what it does)",
        "",
        "-threads 2 -c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    ),
    (
        "NVENC (threads 4, no idea what it does)",
        "",
        "-threads 4 -c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    ),
    (
        "NVENC (2022 config, but audio removed)",
        "",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -an",
    ),
]

def build_ffmpeg_cmd(
    input_path: str,
    pre_input: str,
    post_input: str,
    out_dir: str,
    start_offset_sec: int = START_OFFSET_SEC,
    num_segments: int = DEFAULT_NUM_SEGMENTS,
) -> List[str]:
    """Construct FFmpeg command starting at *start_offset_sec*."""
    start_segment = start_offset_sec // SEGMENT_LENGTH
    """Construct FFmpeg command list.

    Mirrors the segment settings used by go-transcode (4 s segments,
    flat list output). Output files are written to a temporary directory
    and discarded afterwards.
    """
    segment_prefix = "bench"
    # Breakpoint list based on go-transcode logic (cumulative seconds)
    breakpoints = [SEGMENT_LENGTH * i for i in range(start_segment + 1, start_segment + num_segments + 1)]
    last_ts = breakpoints[-1]
    comma_times = ",".join(f"{t:.6f}" for t in breakpoints)

    output_pattern = os.path.join(out_dir, f"{segment_prefix}-%05d.ts")
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-ss",
        f"{start_segment * SEGMENT_LENGTH:.6f}",
    ]
    if pre_input:
        cmd += pre_input.split()
    cmd += [
        "-i",
        input_path,
        "-to",
        f"{last_ts:.6f}",
        "-copyts",
        "-force_key_frames",
        comma_times,
        "-sn",
        "-vf",
        "scale=-2:1080",
    ]
    if post_input:
        cmd += post_input.split()
    cmd += [
        "-f",
        "segment",
        "-segment_time_delta",
        "0.2",
        "-segment_format",
        "mpegts",
        "-segment_times",
        comma_times,
        "-segment_start_number",
        str(start_segment),
        "-segment_list_type",
        "flat",
        "-segment_list",
        "pipe:1",
        output_pattern,
    ]
    return cmd


def run_benchmark(input_path: str, configs=None, num_segments: int = DEFAULT_NUM_SEGMENTS, start_offset_sec: int = START_OFFSET_SEC):
    if configs is None:
        configs = ENCODER_CONFIGS
    gpu = gpu_name()
    if gpu:
        print(f"{CYAN}GPU detected:{RESET} {gpu}")
    else:
        print(f"{CYAN}GPU detected:{RESET} none / nvidia-smi unavailable")

    # ensure ffmpeg exists
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg binary not found in PATH")

    results = []
    for idx, (label, pre_input, post_input) in enumerate(configs, 1):
        print(f"\n{YELLOW}▶ Running configuration {idx}/{len(configs)}:{RESET} {label}")
        with tempfile.TemporaryDirectory() as tmpdir:
            cmd = build_ffmpeg_cmd(input_path, pre_input, post_input, tmpdir, start_offset_sec=start_offset_sec, num_segments=num_segments)
            start = time.perf_counter()
            # Capture stderr to show errors
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
            first_seg_time = None
            seg_pattern = os.path.join(tmpdir, "bench-*.ts")
            while proc.poll() is None:
                created = len(list(glob.glob(seg_pattern)))
                if created and first_seg_time is None:
                    first_seg_time = time.perf_counter() - start
                bar_len = 20
                filled = int((created / num_segments) * bar_len)
                bar = "#" * filled + "-" * (bar_len - filled)
                print(f"\rProgress [{bar}] {created}/{num_segments}", end="", flush=True)
                time.sleep(0.3)
            _, stderr = proc.communicate()
            print()  # newline after progress bar
            if proc.returncode != 0:
                print(f"\n{Fore.RED}{'='*40}\nFFmpeg failed with exit code {proc.returncode}\n{stderr.strip()}\n{'='*40}{RESET}")
                elapsed = None
                first_seg_time = None
            else:
                elapsed = time.perf_counter() - start
                print(f"{GREEN}Finished in {elapsed:.2f} s{RESET}")
            results.append((label, elapsed, first_seg_time))

    # Summary table
    print("\n" + CYAN + "=== Benchmark Summary ===" + RESET)
    pad = max(len(lbl) for lbl, _, _ in results) + 2
    print(f"{'Config'.ljust(pad)} Total  | First")
    print("-" * (pad + 15))
    for lbl, elapsed, first_seg in results:
        if elapsed is None:
            tot_str = f"{Fore.RED}FAIL{RESET}"
            first_str = "-"
        else:
            tot_str = f"{GREEN}{elapsed:.2f}s{RESET}"
            first_str = f"{first_seg:.2f}s" if first_seg else "-"
        print(lbl.ljust(pad) + f" {tot_str:>6} | {first_str}")


def main():
    parser = argparse.ArgumentParser(description="Benchmark FFmpeg encoder settings defined in script.")
    parser.add_argument("input", help="input video file path")
    parser.add_argument("-n", "--segments", type=int, default=DEFAULT_NUM_SEGMENTS, help="number of 4-second segments to encode (default 10)")
    parser.add_argument("-o", "--offset", type=int, default=START_OFFSET_SEC, help="start offset in seconds (default 300)")
    args = parser.parse_args()

    run_benchmark(args.input, num_segments=args.segments, start_offset_sec=args.offset)


if __name__ == "__main__":
    main()
