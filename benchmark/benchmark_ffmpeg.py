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
    # (
    #     "CPU (stock, but audio removed)",
    #     "",
    #     "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -an",
    # ),
    (
        "CPU (stock video, audio copied)",
        "",
        "-c:v libx264 -preset veryfast -profile:v high -crf 23 -c:a copy",
    ),
    (
        "CPU (ultrafast video preset, audio encoded)",
        "",
        "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -c:a aac -b:a 192k",
    ),
    # (
    #     "CPU (stock, opus audio)",
    #     "",
    #     "-c:v libx264 -preset ultrafast -profile:v high -crf 23 -c:a libopus -preset veryfast -b:a 128k",
    # ),
    (
        "NVENC (config recommendation I found in 2022)",
        "",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    ),
    (
        "NVENC (2022 config, half bitrate)",
        "",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 2500k -c:a aac -b:a 192k",
    ),
    (
        "NVENC (2022 config, audio copied)",
        "",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a copy",
    ),
    (
        "NVENC (with nvdec)",
        "-hwaccel nvdec -hwaccel_device 0",
        "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    ),
    # (
    #     "NVENC (threads 2, no idea what it does)",
    #     "",
    #     "-threads 2 -c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    # ),
    # (
    #     "NVENC (threads 4, no idea what it does)",
    #     "",
    #     "-threads 4 -c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -c:a aac -b:a 192k",
    # ),
    # (
    #     "NVENC (2022 config, but audio removed)",
    #     "",
    #     "-c:v h264_nvenc -preset p1 -tune:v ull -profile:v high -rc:v cbr -b:v 5000k -an",
    # ),
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


import statistics

def run_benchmark(input_path: str, configs=None, num_segments: int = DEFAULT_NUM_SEGMENTS, start_offset_sec: int = START_OFFSET_SEC, repeat: int = 1):
    if configs is None:
        configs = ENCODER_CONFIGS

    # ensure ffmpeg exists
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg binary not found in PATH")

    results = []
    for idx, (label, pre_input, post_input) in enumerate(configs, 1):
        print(f"\n{YELLOW}▶ Running configuration {idx}/{len(configs)}:{RESET} {label}")
        elapsed_list = []
        first_seg_list = []
        mean_sizes_list = []
        fail_count = 0
        for run_idx in range(repeat):
            with tempfile.TemporaryDirectory() as tmpdir:
                cmd = build_ffmpeg_cmd(input_path, pre_input, post_input, tmpdir, start_offset_sec=start_offset_sec, num_segments=num_segments)
                start = time.perf_counter()
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
                    print(f"\rRun {run_idx+1}/{repeat} Progress [{bar}] {created}/{num_segments}", end="", flush=True)
                    time.sleep(0.3)
                _, stderr = proc.communicate()
                print()  # newline after progress bar
                if proc.returncode != 0:
                    print(f"\n{Fore.RED}{'='*40}\nFFmpeg failed with exit code {proc.returncode}\n{stderr.strip()}\n{'='*40}{RESET}")
                    fail_count += 1
                else:
                    elapsed = time.perf_counter() - start
                    segment_files = sorted(glob.glob(seg_pattern))
                    if segment_files:
                        sizes = [os.path.getsize(f) for f in segment_files]
                        mean_size = sum(sizes) / len(sizes)
                        print(f"{GREEN}Run {run_idx+1} finished in {elapsed:.2f} s, avg seg size: {mean_size/1024/1024:.1f} MB{RESET}")
                        mean_sizes_list.append(mean_size)
                    else:
                        print(f"{GREEN}Run {run_idx+1} finished in {elapsed:.2f} s, avg seg size: -{RESET}")
                        mean_sizes_list.append(None)
                    elapsed_list.append(elapsed)
                    first_seg_list.append(first_seg_time)
        # Outlier/cold cache handling
        use_elapsed = list(elapsed_list)
        use_first_seg = list(first_seg_list)
        use_sizes = list(mean_sizes_list)
        if repeat > 3 and len(use_elapsed) > 1:
            use_elapsed_drop = use_elapsed[1:]
            use_first_seg = use_first_seg[1:]
            use_sizes_drop = use_sizes[1:]
        else:
            use_elapsed_drop = use_elapsed
            use_sizes_drop = use_sizes
        # Median calculation
        median_elapsed = statistics.median(use_elapsed_drop) if use_elapsed_drop else None
        median_first_seg = statistics.median(use_first_seg) if use_first_seg else None
        median_size = statistics.median([s for s in use_sizes_drop if s is not None]) if any(s is not None for s in use_sizes_drop) else None
        total_time = sum(elapsed_list) if elapsed_list else None
        results.append((label, median_elapsed, median_first_seg, total_time, median_size))

    # Return results for summary printing later
    return results

def print_summary_table(results, segment_count, repeat_count):
    print(f"\n{CYAN}=== Benchmark Summary (Segments: {segment_count}, Repetitions: {repeat_count}) ==={RESET}")
    pad = max(len(lbl) for lbl, _, _, _, _ in results) + 2
    print(f"{'Config'.ljust(pad)} Median   | 1stSeg   | Total Time | Avg Seg Size")
    print("-" * (pad + 47))
    for lbl, median_elapsed, median_first_seg, total_time, median_size in results:
        if median_elapsed is None:
            tot_str = f"{Fore.RED}FAIL{RESET}"
            first_str = "-"
            total_str = "-"
            size_str = "-"
        else:
            tot_str = f"{GREEN}{median_elapsed:.2f}s{RESET}"
            first_str = f"{median_first_seg:.2f}s" if median_first_seg else "-"
            total_str = f"{total_time:.2f}s" if total_time is not None else "-"
            size_str = f"{median_size/1024/1024:.1f} MB" if median_size is not None else "-"
        print(lbl.ljust(pad) + f" {tot_str:>8} | {first_str:>8} | {total_str:>10} | {size_str:>11}")


def parse_segments_arg(val):
    if ',' in val:
        return [int(v.strip()) for v in val.split(',') if v.strip()]
    else:
        return [int(val.strip())]

def main():
    parser = argparse.ArgumentParser(description="Benchmark FFmpeg encoder settings defined in script.")
    parser.add_argument("input", help="input video file path")
    parser.add_argument("-n", "--segments", type=str, default=str(DEFAULT_NUM_SEGMENTS), help="number of 4-second segments to encode (default 10), or comma-separated list for multiple runs")
    parser.add_argument("-o", "--offset", type=int, default=START_OFFSET_SEC, help="start offset in seconds (default 300)")
    parser.add_argument("-r", "--repeat", type=int, default=1, help="number of times to run each configuration (default 1)")
    args = parser.parse_args()

    if args.repeat < 1:
        parser.error("--repeat must be >= 1")

    gpu = gpu_name()
    if gpu:
        print(f"{CYAN}GPU detected:{RESET} {gpu}")
    else:
        print(f"{CYAN}GPU detected:{RESET} none / nvidia-smi unavailable")
    print(f"{CYAN}Repetitions per config:{RESET} {args.repeat}")

    segment_counts = parse_segments_arg(args.segments)
    all_benchmark_runs = []
    for seg_count in segment_counts:
        print(f"\n{'='*20}\nBenchmarking with {seg_count} segments\n{'='*20}")
        results = run_benchmark(args.input, num_segments=seg_count, start_offset_sec=args.offset, repeat=args.repeat)
        all_benchmark_runs.append((seg_count, results))

    # Print all summaries at the end
    for seg_count, results in all_benchmark_runs:
        print_summary_table(results, seg_count, args.repeat)


if __name__ == "__main__":
    main()
