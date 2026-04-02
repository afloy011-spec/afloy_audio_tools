import numpy as np
from PIL import Image, ImageDraw
import torch

WEB_DIRECTORY = "web"


def _fmt_time(sec):
    sec = float(sec)
    m  = int(sec) // 60
    s  = int(sec) % 60
    ms = int((sec - int(sec)) * 100)
    return f"{m:02d}:{s:02d}.{ms:02d}"


def _draw_waveform(waveform, sample_rate, start_sec, end_sec_actual, total_duration):
    """Render waveform image with highlighted trim region. Returns [1,H,W,3] float32 tensor."""

    W, H = 800, 180
    PAD_L, PAD_R, PAD_T, PAD_B = 8, 8, 24, 24
    draw_w = W - PAD_L - PAD_R

    if total_duration <= 0:
        img = Image.new("RGB", (W, H), (28, 28, 32))
        return torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)

    # Mix to mono — guard against unexpected ndim
    wav = waveform[0] if waveform.ndim == 3 else waveform
    audio_np = wav.mean(0).cpu().numpy().astype(np.float32)

    # Downsample: one column = one vertical bar (max/min envelope)
    n      = len(audio_np)
    chunk  = max(1, n // draw_w)
    keep   = (n // chunk) * chunk
    peaks_max = audio_np[:keep].reshape(-1, chunk).max(axis=1)
    peaks_min = audio_np[:keep].reshape(-1, chunk).min(axis=1)
    n_bars = len(peaks_max)

    # RMS per bar for underlay
    rms = np.sqrt((audio_np[:keep].reshape(-1, chunk) ** 2).mean(axis=1))

    img  = Image.new("RGB", (W, H), (28, 28, 32))
    draw = ImageDraw.Draw(img)

    # Selected region background
    sx = PAD_L + int(start_sec      / total_duration * draw_w)
    ex = PAD_L + int(end_sec_actual / total_duration * draw_w)
    draw.rectangle([sx, PAD_T, ex, H - PAD_B], fill=(35, 60, 40))

    # Waveform bars
    mid_y  = PAD_T + (H - PAD_T - PAD_B) // 2
    half_h = (H - PAD_T - PAD_B) // 2 - 2

    for i in range(min(n_bars, draw_w)):
        x = PAD_L + i
        in_sel = sx <= x <= ex

        # RMS underlay
        rms_h = int(rms[i] * half_h)
        rms_color = (45, 80, 55) if in_sel else (50, 50, 60)
        if rms_h > 0:
            draw.line([(x, mid_y - rms_h), (x, mid_y + rms_h)], fill=rms_color)

        # Peak bars
        y_top = mid_y - int(peaks_max[i] * half_h)
        y_bot = mid_y - int(peaks_min[i] * half_h)
        if y_top == y_bot:
            y_bot += 1
        color = (72, 210, 100) if in_sel else (90, 90, 100)
        draw.line([(x, y_top), (x, y_bot)], fill=color)

    # Centre line
    draw.line([(PAD_L, mid_y), (W - PAD_R, mid_y)], fill=(60, 60, 70))

    # Start / end markers
    draw.line([(sx, PAD_T), (sx, H - PAD_B)], fill=(255, 210, 0),  width=2)
    draw.line([(ex, PAD_T), (ex, H - PAD_B)], fill=(255, 100, 60), width=2)

    # Bottom bar — time labels
    draw.rectangle([0, H - PAD_B, W, H], fill=(20, 20, 24))
    labels = [
        (PAD_L,                             "0:00.00"),
        (max(PAD_L, sx - 28),               f"▶{_fmt_time(start_sec)}"),
        (min(W - PAD_R - 60, ex + 2),       f"◀{_fmt_time(end_sec_actual)}"),
        (W - PAD_R - 52,                    _fmt_time(total_duration)),
    ]
    for lx, text in labels:
        draw.text((lx, H - PAD_B + 6), text, fill=(200, 200, 200))

    # Top bar — segment duration
    seg_dur = end_sec_actual - start_sec
    draw.rectangle([0, 0, W, PAD_T], fill=(20, 20, 24))
    draw.text((PAD_L, 4), f"Segment: {_fmt_time(seg_dur)}  ({seg_dur:.3f}s)", fill=(180, 220, 180))

    img_np = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(img_np).unsqueeze(0)  # [1, H, W, 3]


# ---------------------------------------------------------------------------
# 1. Get Audio Duration
# ---------------------------------------------------------------------------

class GetAudioDuration:
    """Returns audio duration in multiple formats + optional frame count."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio": ("AUDIO",),
                "fps":   ("FLOAT", {"default": 24.0, "min": 1.0, "max": 240.0, "step": 0.001}),
            }
        }

    RETURN_TYPES  = ("FLOAT", "INT", "INT", "STRING", "INT", "INT")
    RETURN_NAMES  = ("duration_sec", "duration_sec_int", "frames", "timecode", "sample_rate", "channels")
    FUNCTION      = "get_duration"
    CATEGORY      = "audio/Afloy Audio Tools"

    def get_duration(self, audio, fps):
        waveform    = audio["waveform"]
        sample_rate = audio["sample_rate"]
        samples     = waveform.shape[-1]
        channels    = waveform.shape[-2] if waveform.ndim >= 2 else 1
        duration    = float(samples / sample_rate)
        frames      = int(duration * fps)
        return (duration, int(duration), frames, _fmt_time(duration), int(sample_rate), int(channels))


# ---------------------------------------------------------------------------
# 2. Trim Audio
# ---------------------------------------------------------------------------

class TrimAudio:
    """Cuts a segment from audio by start/end time in seconds.
    Outputs trimmed audio + waveform preview image.
    Set end_sec to -1 to trim from start_sec to the end of the audio.

    The web UI (waveform) reloads when the upstream Load Audio file changes via
    widget callback — see web/trim_audio.js `bindUpstreamAudioWidget`."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "audio":     ("AUDIO",),
                "start_sec": ("FLOAT", {"default": 0.0,  "min": 0.0,  "max": 99999.0, "step": 0.01}),
                "end_sec":   ("FLOAT", {"default": -1.0, "min": -1.0, "max": 99999.0, "step": 0.01}),
            }
        }

    RETURN_TYPES  = ("AUDIO", "IMAGE", "FLOAT", "STRING")
    RETURN_NAMES  = ("audio", "waveform_preview", "duration_sec", "timecode")
    FUNCTION      = "trim"
    CATEGORY      = "audio/Afloy Audio Tools"

    @classmethod
    def IS_CHANGED(cls, audio, start_sec, end_sec):
        """Invalidate cache when tensor or sample rate changes (new clip / resample)."""
        w = audio.get("waveform")
        if w is None or not hasattr(w, "shape"):
            return float("nan")
        sr = float(audio.get("sample_rate", 0))
        wav = w[0] if w.ndim == 3 else w
        n = int(wav.shape[-1])
        ch = int(wav.shape[-2]) if wav.ndim >= 2 else 1
        if n < 1:
            return (0, ch, sr, start_sec, end_sec)
        head = float(wav[..., : min(8, n)].mean().item())
        tail = float(wav[..., -min(8, n) :].mean().item())
        return (n, ch, sr, head, tail, start_sec, end_sec)

    def trim(self, audio, start_sec, end_sec):
        waveform    = audio["waveform"]
        sample_rate = audio["sample_rate"]

        total_samples  = waveform.shape[-1]
        if total_samples < 1:
            raise ValueError(
                "Afloy Audio Trim: input has no samples (check the file in Load Audio)."
            )
        total_duration = total_samples / sample_rate

        start_sec    = max(0.0, min(start_sec, total_duration))
        start_sample = int(start_sec * sample_rate)
        start_sample = min(start_sample, max(0, total_samples - 1))
        end_sample   = total_samples if end_sec < 0 else int(min(end_sec, total_duration) * sample_rate)
        end_sample   = max(end_sample, start_sample + 1)

        end_sec_actual = end_sample / sample_rate
        trimmed        = waveform[..., start_sample:end_sample]
        duration       = max(
            float(trimmed.shape[-1] / sample_rate),
            1.0 / float(sample_rate),
        )
        preview_img    = _draw_waveform(waveform, sample_rate, start_sec, end_sec_actual, total_duration)

        return ({"waveform": trimmed, "sample_rate": sample_rate}, preview_img, duration, _fmt_time(duration))


# ---------------------------------------------------------------------------
# 3. Audio Info
# ---------------------------------------------------------------------------

class AudioInfo:
    """Outputs metadata of an audio tensor as individual values and a summary string."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"audio": ("AUDIO",)}}

    RETURN_TYPES  = ("INT", "INT", "INT", "FLOAT", "STRING")
    RETURN_NAMES  = ("sample_rate", "channels", "total_samples", "duration_sec", "info")
    FUNCTION      = "get_info"
    CATEGORY      = "audio/Afloy Audio Tools"

    def get_info(self, audio):
        waveform    = audio["waveform"]
        sample_rate = audio["sample_rate"]

        total_samples = waveform.shape[-1]
        channels      = waveform.shape[-2] if waveform.ndim >= 2 else 1
        duration      = float(total_samples / sample_rate)

        info = (
            f"Duration: {_fmt_time(duration)} ({duration:.3f}s)\n"
            f"Sample rate: {sample_rate} Hz\n"
            f"Channels: {channels}\n"
            f"Samples: {total_samples}\n"
            f"Batch: {waveform.shape[0] if waveform.ndim == 3 else 1}"
        )
        return (int(sample_rate), int(channels), int(total_samples), duration, info)


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

NODE_CLASS_MAPPINGS = {
    "afloy_GetAudioDuration": GetAudioDuration,
    "afloy_TrimAudio":        TrimAudio,
    "afloy_AudioInfo":        AudioInfo,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "afloy_GetAudioDuration": "Afloy Audio Duration",
    "afloy_TrimAudio":        "Afloy Audio Trim",
    "afloy_AudioInfo":        "Afloy Audio Info",
}
