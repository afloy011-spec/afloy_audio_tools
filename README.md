# Afloy Audio Tools

Custom audio nodes for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — professional audio editing right inside your workflow.

![Afloy Audio Trim — interactive waveform](docs/trim_audio_preview.png)

<a href="#installation" style="display:inline-block;padding:10px 18px;background:#2ea44f;color:white;text-decoration:none;border-radius:6px;font-weight:600;">Install</a>

---

## Quick Start (Afloy Audio Trim)

Use the main node to trim audio directly in your workflow.

1. Add an `Afloy Audio Trim` node and connect `audio`.
2. Drag `start_sec` / `end_sec` markers (or press `Tab` to switch, `I`/`O` to set from the cursor).
3. Drag the white scrub cursor to seek; press `Space` to play/stop.
4. Use `+`/`-` (or mouse wheel) for zoom and `Shift + mouse wheel` for horizontal scroll.

Widget highlights:

- Filled-polygon waveform (classic DAW look)
- Draggable start/end markers with zero-crossing snap
- Draggable scrub cursor — click to place, drag to seek
- Play from cursor position (constrained to selection)
- Region drag — grab inside the selection to move both markers
- Zoom up to 50x via `+`/`-` buttons or mouse wheel
- Horizontal scroll with `Shift + mouse wheel`
- In-node playback with loop toggle
- Hover tooltip showing time under cursor

**Keyboard shortcuts** (when the node is selected):

| Key | Action |
|:---|:---|
| `Space` | Play / Stop |
| `Shift + ←` `→` | Nudge active marker by 1 second |
| `Tab` | Switch active marker (start ↔ end) |
| `I` | Set start marker to cursor / playback position |
| `O` | Set end marker to cursor / playback position |

---

## Nodes

All three nodes appear under **audio > Afloy Audio Tools** in the node menu.

### Afloy Audio Trim

Interactive audio trimmer with a DAW-style waveform widget.

| Input | Type | Description |
|:---|:---|:---|
| `audio` | AUDIO | Source audio |
| `start_sec` | FLOAT | Trim start (seconds) |
| `end_sec` | FLOAT | Trim end (`-1` = end of file) |

| Output | Type | Description |
|:---|:---|:---|
| `audio` | AUDIO | Trimmed segment |
| `waveform_preview` | IMAGE | Static waveform image |
| `duration_sec` | FLOAT | Segment length |
| `timecode` | STRING | `MM:SS.ms` timecode |

---

### Afloy Audio Duration

Returns audio length in multiple formats — useful for syncing with video/animation.

| Input | Type | Description |
|:---|:---|:---|
| `audio` | AUDIO | Source audio |
| `fps` | FLOAT | Frames per second (default 24) |

| Output | Type | Description |
|:---|:---|:---|
| `duration_sec` | FLOAT | Duration in seconds |
| `duration_sec_int` | INT | Rounded duration |
| `frames` | INT | Frame count at given FPS |
| `timecode` | STRING | `MM:SS.ms` |
| `sample_rate` | INT | Hz |
| `channels` | INT | Mono/Stereo |

---

### Afloy Audio Info

Diagnostic node that outputs audio metadata as individual values and a summary string.

| Input | Type | Description |
|:---|:---|:---|
| `audio` | AUDIO | Source audio |

| Output | Type | Description |
|:---|:---|:---|
| `sample_rate` | INT | Sample rate in Hz |
| `channels` | INT | Number of channels |
| `total_samples` | INT | Total sample count |
| `duration_sec` | FLOAT | Duration in seconds |
| `info` | STRING | Human-readable summary |

---

## Installation

### Manual

```bash
cd ComfyUI/custom_nodes
git clone https://github.com/afloy011-spec/afloy_audio_tools.git "Afloy Audio Tools"
```

Restart ComfyUI. No additional Python dependencies — the nodes use `numpy`, `Pillow`, and `torch` which are already part of ComfyUI.

---

## Requirements

- ComfyUI (any recent version)
- Python 3.10+
- No extra pip packages needed

---

## License

[MIT](LICENSE)
