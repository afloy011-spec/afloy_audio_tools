const { app } = window.comfyAPI.app;

const LABEL_H       = 18;
const WAVE_AREA_H   = 122;
const REFRESH_ROW_H = 34;  // reload row (toolbar height)
const TOOLBAR_H     = REFRESH_ROW_H;
const WAVE_H        = LABEL_H + TOOLBAR_H + WAVE_AREA_H; // 174
const PAD           = 8;
const MARKER_HIT    = 8;
const FRAME_STEP_KEYS = { ArrowLeft: -1, ArrowRight: 1 };

// ─── helpers ──────────────────────────────────────────────────────────────────

/** Vector reload icon (no font glyphs). */
function drawReloadIcon(ctx, cx, cy, r, stroke) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 2.25;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const a0 = 0.4 * Math.PI;
    const a1 = 1.85 * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, r, a0, a1);
    ctx.stroke();
    const tipX = cx + r * Math.cos(a1);
    const tipY = cy + r * Math.sin(a1);
    const tx   = -Math.sin(a1);
    const ty   = Math.cos(a1);
    ctx.beginPath();
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 5.5 * tx + 3 * ty, tipY - 5.5 * ty - 3 * tx);
    ctx.moveTo(tipX, tipY);
    ctx.lineTo(tipX - 5.5 * tx - 3 * ty, tipY - 5.5 * ty + 3 * tx);
    ctx.stroke();
}

function fmt(sec) {
    sec = Math.max(0, Number(sec) || 0);
    const m  = Math.floor(sec / 60);
    const s  = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 100);
    return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}.${String(ms).padStart(2,"0")}`;
}

function buildPeaks(audioBuffer, numBars) {
    let mono = null;
    for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        const ch = audioBuffer.getChannelData(c);
        if (!mono) { mono = new Float32Array(ch); }
        else { for (let i = 0; i < mono.length; i++) mono[i] += ch[i]; }
    }
    if (audioBuffer.numberOfChannels > 1) {
        const inv = 1 / audioBuffer.numberOfChannels;
        for (let i = 0; i < mono.length; i++) mono[i] *= inv;
    }
    const step   = Math.max(1, Math.floor(mono.length / numBars));
    const maxArr = new Float32Array(numBars);
    const minArr = new Float32Array(numBars);
    for (let i = 0; i < numBars; i++) {
        let mx = 0, mn = 0;
        const off = i * step;
        for (let j = 0; j < step && off + j < mono.length; j++) {
            const v = mono[off + j];
            if (v > mx) mx = v;
            if (v < mn) mn = v;
        }
        maxArr[i] = mx;
        minArr[i] = mn;
    }
    return { max: maxArr, min: minArr };
}

function snapToZeroCrossing(audioBuffer, timeSec, windowMs = 5) {
    if (!audioBuffer) return timeSec;
    const sr   = audioBuffer.sampleRate;
    const mono = audioBuffer.getChannelData(0);
    const center = Math.round(timeSec * sr);
    const half   = Math.round((windowMs / 1000) * sr);
    const lo     = Math.max(0, center - half);
    const hi     = Math.min(mono.length - 2, center + half);
    let best = center, bestDist = half + 1;
    for (let i = lo; i <= hi; i++) {
        if ((mono[i] >= 0 && mono[i + 1] < 0) || (mono[i] < 0 && mono[i + 1] >= 0)) {
            const dist = Math.abs(i - center);
            if (dist < bestDist) { bestDist = dist; best = i; }
        }
    }
    return best / sr;
}

// ─── chainCallback util ───────────────────────────────────────────────────────

function chainCallback(object, property, callback) {
    if (object == undefined) { console.error("[AudioTools] chainCallback: undefined object"); return; }
    if (property in object) {
        const _orig = object[property];
        object[property] = function() { const r = _orig.apply(this, arguments); callback.apply(this, arguments); return r; };
    } else {
        object[property] = callback;
    }
}

// ─── extension ────────────────────────────────────────────────────────────────

app.registerExtension({
    name: "comfy.AudioTools.TrimAudio",

    async beforeRegisterNodeDef(nodeType, nodeData) {
        if (nodeData?.name !== "afloy_TrimAudio") return;
        chainCallback(nodeType.prototype, "onNodeCreated", function() {
            try { setupWaveformWidget(this); }
            catch (e) { console.error("[AudioTools] setup error:", e); }
        });
    },
});

// ─── setup ────────────────────────────────────────────────────────────────────

function setupWaveformWidget(node) {
    const st = {
        audioBuffer  : null,
        peaks        : null,

        audioCtx     : null,
        playSource   : null,
        playStartAt  : 0,
        playOffset   : 0,
        playDuration : 0,
        rafId        : null,
        dragging     : null,
        hoverX       : null,
        lastSourceKey: null,
        widgetY      : 0,
        loading      : false,
        zoom         : 1.0,
        scrollOffset : 0.0,
        activeMarker : "start",
        looping      : false,
        scrubTime    : null,
    };

    const gw      = (name) => node.widgets?.find(x => x.name === name);
    const dur     = ()     => st.audioBuffer?.duration ?? 1;
    const startT  = ()     => gw("start_sec")?.value ?? 0;
    const endT    = ()     => { const v = gw("end_sec")?.value ?? -1; return v < 0 ? dur() : v; };
    const applyZoomAt = (lx, wheelDeltaY) => {
        if (!st.audioBuffer) return false;
        const W = node.size[0] - PAD * 2;
        if (lx < 0 || lx > W) return false;
        const d    = st.audioBuffer.duration || 1;
        const z    = st.zoom;
        const visD = d / z;
        const so   = st.scrollOffset;
        const pxToTime = (px) => so + (px / W) * visD;
        const delta = wheelDeltaY > 0 ? -0.15 : 0.15;
        const pivot = pxToTime(lx);
        st.zoom = Math.max(1.0, Math.min(50.0, st.zoom * (1 + delta)));
        const newVisD = d / st.zoom;
        st.scrollOffset = Math.max(0, Math.min(d - newVisD, pivot - (lx / W) * newVisD));
        node.setDirtyCanvas(true, false);
        return true;
    };

    // ── widget ────────────────────────────────────────────────────────────────
    const ww = {
        name: "waveform_display",
        type: "waveform",

        computeSize(nodeW) { return [nodeW, WAVE_H]; },

        draw(ctx, node, nodeW, y) {
            st.widgetY = y;
            const W  = nodeW - PAD * 2;
            const innerH = WAVE_H - LABEL_H;
            const waveY = y + TOOLBAR_H;
            const h  = innerH - TOOLBAR_H;
            const x0 = PAD;

            ctx.save();

            // ── TOOLBAR: single row, controls outside the waveform ────────────
            {
                const bH  = 24;
                const bYc = y + Math.floor((TOOLBAR_H - bH) / 2);
                const z   = st.zoom;

                // Toolbar background + bottom separator
                ctx.fillStyle = "#0e0f18";
                ctx.fillRect(x0, y, W, TOOLBAR_H);
                ctx.strokeStyle = "#1e1e30";
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(x0, y + TOOLBAR_H - 0.5);
                ctx.lineTo(x0 + W, y + TOOLBAR_H - 0.5);
                ctx.stroke();

                // Button positions right-to-left
                let rx = x0 + W - 4;
                const bPlayW = 36, bPlayX = rx - bPlayW; rx = bPlayX - 3;
                const bLoopW = 26, bLoopX = rx - bLoopW; rx = bLoopX - 8;
                const bPlusW = 24, bPlusX = rx - bPlusW; rx = bPlusX - 2;
                const bMinusW = 24, bMinusX = rx - bMinusW; rx = bMinusX - 2;
                const bZoomW = 36, bZoomX = rx - bZoomW; rx = bZoomX - 5;
                const bRefX  = x0 + 4, bRefW = rx - bRefX;

                // ── Play / Stop ──────────────────────────────────────────────
                ctx.fillStyle   = st.playSource ? "#3a1010" : "#0c2e1a";
                ctx.fillRect(bPlayX, bYc, bPlayW, bH);
                ctx.strokeStyle = st.playSource ? "#cc3333" : "#18843a";
                ctx.lineWidth   = 1;
                ctx.strokeRect(bPlayX, bYc, bPlayW, bH);
                ctx.fillStyle   = "#ffffff";
                ctx.font        = "12px sans-serif";
                ctx.textAlign   = "center";
                ctx.textBaseline = "middle";
                ctx.fillText(st.playSource ? "\u25A0" : "\u25B6", bPlayX + bPlayW / 2, bYc + bH / 2);

                // ── Loop toggle ──────────────────────────────────────────────
                ctx.fillStyle   = st.looping ? "#0c3545" : "#131320";
                ctx.fillRect(bLoopX, bYc, bLoopW, bH);
                ctx.strokeStyle = st.looping ? "#1888aa" : "#1e1e2e";
                ctx.lineWidth   = 1;
                ctx.strokeRect(bLoopX, bYc, bLoopW, bH);
                ctx.fillStyle   = st.looping ? "#20c0de" : "#424265";
                ctx.font        = "12px sans-serif";
                ctx.textAlign   = "center";
                ctx.fillText("\u27F3", bLoopX + bLoopW / 2, bYc + bH / 2);

                // Separator between zoom group and loop/play
                ctx.strokeStyle = "#262636";
                ctx.lineWidth   = 1;
                ctx.beginPath();
                ctx.moveTo(bLoopX + bLoopW + 4, bYc + 4);
                ctx.lineTo(bLoopX + bLoopW + 4, bYc + bH - 4);
                ctx.stroke();

                // ── Zoom + ──────────────────────────────────────────────────
                ctx.fillStyle   = "#131320";
                ctx.fillRect(bPlusX, bYc, bPlusW, bH);
                ctx.strokeStyle = "#1c1c2c";
                ctx.lineWidth   = 1;
                ctx.strokeRect(bPlusX, bYc, bPlusW, bH);
                ctx.fillStyle   = "#6868a0";
                ctx.font        = "bold 14px monospace";
                ctx.textAlign   = "center";
                ctx.fillText("+", bPlusX + bPlusW / 2, bYc + bH / 2);

                // ── Zoom − ──────────────────────────────────────────────────
                ctx.fillStyle   = "#131320";
                ctx.fillRect(bMinusX, bYc, bMinusW, bH);
                ctx.strokeStyle = "#1c1c2c";
                ctx.lineWidth   = 1;
                ctx.strokeRect(bMinusX, bYc, bMinusW, bH);
                ctx.fillStyle   = "#6868a0";
                ctx.font        = "bold 14px monospace";
                ctx.textAlign   = "center";
                ctx.fillText("\u2212", bMinusX + bMinusW / 2, bYc + bH / 2);

                // ── Zoom reset ───────────────────────────────────────────────
                const isZoomed = z > 1.05;
                const zLabel   = isZoomed ? `\u00d7${z.toFixed(1)}` : "1\u00d7";
                ctx.fillStyle   = isZoomed ? "#0a2530" : "#131320";
                ctx.fillRect(bZoomX, bYc, bZoomW, bH);
                ctx.strokeStyle = isZoomed ? "#1e5c72" : "#1c1c2c";
                ctx.lineWidth   = 1;
                ctx.strokeRect(bZoomX, bYc, bZoomW, bH);
                ctx.fillStyle   = isZoomed ? "#28c0de" : "#484868";
                ctx.font        = "bold 10px monospace";
                ctx.textAlign   = "center";
                ctx.fillText(zLabel, bZoomX + bZoomW / 2, bYc + bH / 2);

                // ── Reload ───────────────────────────────────────────────────
                if (st.loading) {
                    ctx.fillStyle   = "#16181f";
                    ctx.fillRect(bRefX, bYc, bRefW, bH);
                    ctx.strokeStyle = "#252535";
                    ctx.lineWidth   = 1;
                    ctx.strokeRect(bRefX, bYc, bRefW, bH);
                    ctx.fillStyle   = "#556070";
                    ctx.font        = "11px system-ui, sans-serif";
                    ctx.textAlign   = "left";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Loading from disk\u2026", bRefX + 10, bYc + bH / 2);
                } else {
                    ctx.fillStyle   = "#0e1e38";
                    ctx.fillRect(bRefX, bYc, bRefW, bH);
                    ctx.strokeStyle = "#1c3d72";
                    ctx.lineWidth   = 1;
                    ctx.strokeRect(bRefX, bYc, bRefW, bH);
                    drawReloadIcon(ctx, bRefX + 13, bYc + bH / 2, 5.5, "#4a8fd6");
                    ctx.fillStyle   = "#a8c8f0";
                    ctx.font        = "11px system-ui, sans-serif";
                    ctx.textAlign   = "left";
                    ctx.textBaseline = "middle";
                    ctx.fillText("Reload", bRefX + 25, bYc + bH / 2);
                    // F5 badge
                    ctx.font = "bold 9px monospace";
                    const kbW = ctx.measureText("F5").width + 8;
                    const kbX = bRefX + bRefW - kbW - 4;
                    const kbY = bYc + (bH - 14) / 2;
                    ctx.fillStyle   = "#0a1a35";
                    ctx.fillRect(kbX, kbY, kbW, 14);
                    ctx.strokeStyle = "#1c3d72";
                    ctx.lineWidth   = 0.75;
                    ctx.strokeRect(kbX, kbY, kbW, 14);
                    ctx.fillStyle   = "#4a80c8";
                    ctx.textAlign   = "center";
                    ctx.textBaseline = "middle";
                    ctx.fillText("F5", kbX + kbW / 2, kbY + 7);
                }
                ctx.textBaseline = "alphabetic";
            }

            ctx.fillStyle = "#181820";
            ctx.fillRect(x0, waveY, W, h);
            ctx.strokeStyle = "#333344";
            ctx.lineWidth = 1;
            ctx.strokeRect(x0, waveY, W, h);

            const d  = dur();
            const z  = st.zoom;
            const visD = d / z;
            const so = st.scrollOffset;

            const timeToX = (t) => x0 + ((t - so) / visD) * W;
            const xToTime = (px) => so + ((px - x0) / W) * visD;

            const s  = startT();
            const e  = endT();
            const sx = timeToX(s);
            const ex = timeToX(e);

            if (st.loading) {
                ctx.fillStyle = "#556";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("Loading waveform…", x0 + W / 2, waveY + h / 2 + 4);

            } else if (st.peaks) {
                const { max, min } = st.peaks;
                const midY  = waveY + h / 2;
                const halfH = h / 2 - 4;

                // selected zone
                const selL = Math.max(x0, sx);
                const selR = Math.min(x0 + W, ex);
                if (selR > selL) {
                    ctx.fillStyle = "rgba(72,210,100,0.10)";
                    ctx.fillRect(selL, waveY, selR - selL, h);
                }

                // waveform as filled polygon (classic DAW style)
                ctx.save();
                ctx.beginPath();
                ctx.rect(x0, waveY, W, h);
                ctx.clip();

                const wavePoly = () => {
                    ctx.beginPath();
                    for (let i = 0; i < max.length; i++) {
                        const bx = timeToX((i / max.length) * d);
                        if (i === 0) ctx.moveTo(bx, midY - max[i] * halfH);
                        else ctx.lineTo(bx, midY - max[i] * halfH);
                    }
                    for (let i = max.length - 1; i >= 0; i--) {
                        const bx = timeToX((i / max.length) * d);
                        ctx.lineTo(bx, midY - min[i] * halfH);
                    }
                    ctx.closePath();
                };

                wavePoly();
                ctx.fillStyle = "#44445c";
                ctx.fill();

                if (selR > selL) {
                    ctx.save();
                    ctx.beginPath();
                    ctx.rect(selL, waveY, selR - selL, h);
                    ctx.clip();
                    wavePoly();
                    ctx.fillStyle = "#30a848";
                    ctx.fill();
                    ctx.restore();
                }

                // centre line
                ctx.strokeStyle = "#252530";
                ctx.lineWidth = 0.5;
                ctx.beginPath();
                ctx.moveTo(x0, midY);
                ctx.lineTo(x0 + W, midY);
                ctx.stroke();

                ctx.restore();

            } else {
                ctx.fillStyle = "#444455";
                ctx.font = "11px sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("Connect audio input to see waveform", x0 + W / 2, waveY + h / 2 + 4);
            }

            // start marker
            if (sx >= x0 - 2 && sx <= x0 + W + 2) {
                ctx.strokeStyle = "#ffd200"; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(sx, waveY); ctx.lineTo(sx, waveY + h); ctx.stroke();
                ctx.fillStyle = "#ffd200";
                ctx.beginPath(); ctx.moveTo(sx, waveY); ctx.lineTo(sx + 9, waveY + 11); ctx.lineTo(sx, waveY + 11);
                ctx.closePath(); ctx.fill();
            }

            // end marker
            if (ex >= x0 - 2 && ex <= x0 + W + 2) {
                ctx.strokeStyle = "#ff6440"; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(ex, waveY); ctx.lineTo(ex, waveY + h); ctx.stroke();
                ctx.fillStyle = "#ff6440";
                ctx.beginPath(); ctx.moveTo(ex, waveY); ctx.lineTo(ex - 9, waveY + 11); ctx.lineTo(ex, waveY + 11);
                ctx.closePath(); ctx.fill();
            }

            // ── drag labels ──────────────────────────────────────────────────
            if (st.dragging && (st.dragging === "start" || st.dragging === "end")) {
                const isDragStart = st.dragging === "start";
                const mx  = isDragStart ? sx : ex;
                const val = isDragStart ? s : e;
                const lbl = fmt(val);

                ctx.font = "bold 12px monospace";
                const tw  = ctx.measureText(lbl).width + 8;
                const lx  = (mx + tw + 4 <= x0 + W) ? mx + 4 : mx - tw - 4;
                const ly  = waveY + 6;

                ctx.fillStyle = isDragStart ? "#ffd200" : "#ff6440";
                ctx.fillRect(lx, ly, tw, 18);
                ctx.fillStyle = "#111";
                ctx.textAlign = "left";
                ctx.fillText(lbl, lx + 4, ly + 13);
            }

            // ── hover tooltip ─────────────────────────────────────────────────
            if (st.hoverX !== null && !st.dragging && st.peaks) {
                const hx  = x0 + st.hoverX;
                const sec = xToTime(hx);

                if (sec >= 0 && sec <= d) {
                    ctx.strokeStyle = "rgba(200,200,220,0.4)";
                    ctx.lineWidth = 1;
                    ctx.setLineDash([3, 3]);
                    ctx.beginPath();
                    ctx.moveTo(hx, waveY);
                    ctx.lineTo(hx, waveY + h);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    const lbl = fmt(sec);
                    ctx.font = "10px monospace";
                    const tw  = ctx.measureText(lbl).width + 6;
                    const lx  = Math.min(hx + 4, x0 + W - tw - 2);
                    const ly  = waveY + h - 16;

                    ctx.fillStyle = "rgba(40,40,50,0.85)";
                    ctx.fillRect(lx, ly, tw, 14);
                    ctx.fillStyle = "#bbb";
                    ctx.textAlign = "left";
                    ctx.fillText(lbl, lx + 3, ly + 11);
                }
            }

            // ── cursor (playback or scrub) ────────────────────────────────────
            {
                let curT = null;
                if (st.playSource && st.audioCtx) {
                    const elapsed = st.audioCtx.currentTime - st.playStartAt;
                    curT = st.playOffset + Math.min(elapsed, st.playDuration);
                } else if (st.scrubTime !== null) {
                    curT = st.scrubTime;
                }
                if (curT !== null) {
                    const cx = timeToX(curT);
                    if (cx >= x0 && cx <= x0 + W) {
                        ctx.strokeStyle = "rgba(255,255,255,0.85)";
                        ctx.lineWidth = 1.5;
                        ctx.beginPath();
                        ctx.moveTo(cx, waveY);
                        ctx.lineTo(cx, waveY + h);
                        ctx.stroke();
                        ctx.fillStyle = "rgba(255,255,255,0.85)";
                        ctx.beginPath();
                        ctx.arc(cx, waveY + h / 2, 4, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    if (st.playSource) {
                        ctx.fillStyle = "rgba(40,40,50,0.80)";
                        ctx.fillRect(x0 + 2, waveY + h - 16, 64, 14);
                        ctx.fillStyle = "#eee";
                        ctx.font = "10px monospace";
                        ctx.textAlign = "left";
                        ctx.fillText(fmt(curT), x0 + 5, waveY + h - 5);
                    }
                }
            }

            // ── bottom labels ─────────────────────────────────────────────────
            const labY = waveY + h + LABEL_H - 4;
            ctx.fillStyle = "#778"; ctx.font = "10px monospace";
            ctx.textAlign = "left";   ctx.fillText(fmt(s),             x0,         labY);
            ctx.textAlign = "center"; ctx.fillText(`[ ${fmt(e - s)} ]`, x0 + W / 2, labY);
            ctx.textAlign = "right";  ctx.fillText(fmt(d),             x0 + W,     labY);

            ctx.restore();
        },

        mouse(event, pos, node) {
            try { return handleMouse(event, pos, node, st, ww); }
            catch (e) { console.warn("[AudioTools] mouse error:", e); return false; }
        },
    };

    node.addCustomWidget(ww);
    node.setSize(node.computeSize());

    // DOM-level wheel zoom — capture phase intercepts before LiteGraph zooms the canvas.
    setTimeout(() => {
        const gc = app.canvas;
        const canvasEl = gc?.canvas;
        if (!canvasEl) return;
        const onWheel = (e) => {
            if (!st.audioBuffer || !st.peaks) return;
            const rect = canvasEl.getBoundingClientRect();
            const px = e.clientX - rect.left;
            const py = e.clientY - rect.top;
            const sc = gc.ds?.scale ?? 1;
            const ox = gc.ds?.offset?.[0] ?? 0;
            const oy = gc.ds?.offset?.[1] ?? 0;
            const gx = px / sc - ox;
            const gy = py / sc - oy;
            const localX = gx - node.pos[0] - PAD;
            const localY = gy - node.pos[1] - st.widgetY;
            const W = node.size[0] - PAD * 2;
            const innerH = WAVE_H - LABEL_H;
            if (localX < 0 || localX > W || localY < TOOLBAR_H || localY > innerH) return;
            const dy = e.deltaY;
            if (!dy) return;
            const dur = st.audioBuffer.duration || 1;
            let handled = false;
            if (e.shiftKey && st.zoom > 1.05) {
                const visD = dur / st.zoom;
                const pan  = (dy > 0 ? 1 : -1) * visD * 0.12;
                st.scrollOffset = Math.max(0, Math.min(dur - visD, st.scrollOffset + pan));
                node.setDirtyCanvas(true, false);
                handled = true;
            } else {
                handled = applyZoomAt(localX, dy);
            }
            if (handled) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
            }
        };
        canvasEl.addEventListener("wheel", onWheel, { passive: false, capture: true });
        const origRemoved = node.onRemoved;
        node.onRemoved = function() {
            canvasEl.removeEventListener("wheel", onWheel, { capture: true });
            origRemoved?.apply(this, arguments);
        };
    }, 500);

    // ── keyboard: Space, arrows, I/O, Tab ──────────────────────────────────────
    const origKey = node.onKeyDown;
    node.onKeyDown = function(e) {
        try { origKey?.apply(this, arguments); } catch (_) {}

        if (e.code === "F5") {
            e.preventDefault();
            if (e.stopPropagation) e.stopPropagation();
            if (!st.loading) loadAudio(node, st, true);
            return true;
        }

        if (e.key === " ") {
            e.preventDefault();
            // Space: play/pause only (reload: F5 or toolbar button).
            if (!st.audioBuffer) return true;
            doPlay(node, st);
            return true;
        }

        if (!st.audioBuffer) return;
        const d   = st.audioBuffer.duration;
        if (e.shiftKey && (e.code in FRAME_STEP_KEYS)) {
            e.preventDefault();
            const step  = FRAME_STEP_KEYS[e.code];
            const name  = st.activeMarker === "start" ? "start_sec" : "end_sec";
            const wid   = node.widgets?.find(x => x.name === name);
            const other = st.activeMarker === "start"
                ? (node.widgets?.find(x => x.name === "end_sec")?.value ?? -1)
                : (node.widgets?.find(x => x.name === "start_sec")?.value ?? 0);
            const otherVal = st.activeMarker === "start" ? (other < 0 ? d : other) : other;
            if (wid) {
                let nv = wid.value + step;
                if (st.activeMarker === "start") nv = Math.max(0, Math.min(nv, otherVal - 0.01));
                else                             nv = Math.max(otherVal + 0.01, Math.min(nv, d));
                wid.value = Math.round(nv * 100) / 100;
                wid.callback?.(wid.value);
                node.setDirtyCanvas(true, true);
            }
            return true;
        }
        if (e.key === "Tab") {
            e.preventDefault();
            st.activeMarker = st.activeMarker === "start" ? "end" : "start";
            node.setDirtyCanvas(true, false);
            return true;
        }
        if (e.code === "KeyI") {
            let curT = null;
            if (st.playSource && st.audioCtx) {
                const elapsed = st.audioCtx.currentTime - st.playStartAt;
                curT = st.playOffset + Math.min(elapsed, st.playDuration);
            } else if (st.scrubTime !== null) {
                curT = st.scrubTime;
            }
            if (curT !== null) {
                const wid = node.widgets?.find(x => x.name === "start_sec");
                if (wid) { wid.value = Math.round(curT * 100) / 100; wid.callback?.(wid.value); }
                node.setDirtyCanvas(true, true);
            }
            return true;
        }
        if (e.code === "KeyO") {
            let curT = null;
            if (st.playSource && st.audioCtx) {
                const elapsed = st.audioCtx.currentTime - st.playStartAt;
                curT = st.playOffset + Math.min(elapsed, st.playDuration);
            } else if (st.scrubTime !== null) {
                curT = st.scrubTime;
            }
            if (curT !== null) {
                const wid = node.widgets?.find(x => x.name === "end_sec");
                if (wid) { wid.value = Math.round(curT * 100) / 100; wid.callback?.(wid.value); }
                node.setDirtyCanvas(true, true);
            }
            return true;
        }
    };

    // ── connection change: re-bind Load Audio widget callback ───────────────
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function(type, slotIndex, connected) {
        try { origConn?.apply(this, arguments); } catch (_) {}
        if (slotIndex === 0) {
            bindUpstreamAudioWidget(node, st);
            setTimeout(() => loadAudio(node, st, true), 120);
        }
    };

    const origRemovedNode = node.onRemoved;
    node.onRemoved = function () {
        teardownTrimAudioWatchers(st);
        origRemovedNode?.apply(this, arguments);
    };

    bindUpstreamAudioWidget(node, st);
    setTimeout(() => loadAudio(node, st, true), 400);
}

// ─── mouse handler ────────────────────────────────────────────────────────────

function handleMouse(event, pos, node, st, ww) {
    const W  = node.size[0] - PAD * 2;
    const innerH = WAVE_H - LABEL_H;
    const x0 = PAD;
    const y0 = st.widgetY;

    const lx = pos[0] - x0;
    const ly = pos[1] - y0;

    const d    = st.audioBuffer?.duration ?? 1;
    const z    = st.zoom;
    const visD = d / z;
    const so   = st.scrollOffset;
    const pxToTime = (px) => so + (px / W) * visD;
    const timeToPx = (t)  => ((t - so) / visD) * W;

    const sv = node.widgets?.find(x => x.name === "start_sec")?.value ?? 0;
    const ev = node.widgets?.find(x => x.name === "end_sec")?.value ?? -1;
    const eActual = ev < 0 ? d : ev;
    const sxPx = timeToPx(sv);
    const exPx = timeToPx(eActual);

    // ── toolbar hit-test (same geometry as draw) ─────────────────────────────
    if (ly >= 0 && ly <= TOOLBAR_H) {
        const bH  = 24;
        const bYc = Math.floor((TOOLBAR_H - bH) / 2);

        let rx = W - 4;
        const bPlayW = 36, bPlayX = rx - bPlayW; rx = bPlayX - 3;
        const bLoopW = 26, bLoopX = rx - bLoopW; rx = bLoopX - 8;
        const bPlusW = 24, bPlusX = rx - bPlusW; rx = bPlusX - 2;
        const bMinusW = 24, bMinusX = rx - bMinusW; rx = bMinusX - 2;
        const bZoomW = 36, bZoomX = rx - bZoomW; rx = bZoomX - 5;
        const bRefX  = 4, bRefW = rx - bRefX;

        if (event.type === "pointerdown" && ly >= bYc && ly <= bYc + bH) {
            if (lx >= bRefX && lx <= bRefX + bRefW) {
                if (!st.loading) loadAudio(node, st, true);
                return true;
            }
            if (lx >= bPlayX && lx <= bPlayX + bPlayW) {
                doPlay(node, st);
                return true;
            }
            if (lx >= bLoopX && lx <= bLoopX + bLoopW) {
                st.looping = !st.looping;
                node.setDirtyCanvas(true, false);
                return true;
            }
            const dur2 = st.audioBuffer?.duration ?? 1;
            if (lx >= bMinusX && lx <= bMinusX + bMinusW) {
                const center = st.scrollOffset + (dur2 / st.zoom) * 0.5;
                st.zoom = Math.max(1.0, st.zoom / 1.3);
                const vis = dur2 / st.zoom;
                st.scrollOffset = Math.max(0, Math.min(dur2 - vis, center - vis * 0.5));
                node.setDirtyCanvas(true, false);
                return true;
            }
            if (lx >= bPlusX && lx <= bPlusX + bPlusW) {
                const center = st.scrollOffset + (dur2 / st.zoom) * 0.5;
                st.zoom = Math.min(50.0, st.zoom * 1.3);
                const vis = dur2 / st.zoom;
                st.scrollOffset = Math.max(0, Math.min(dur2 - vis, center - vis * 0.5));
                node.setDirtyCanvas(true, false);
                return true;
            }
            if (lx >= bZoomX && lx <= bZoomX + bZoomW) {
                st.zoom = 1.0;
                st.scrollOffset = 0.0;
                node.setDirtyCanvas(true, false);
                return true;
            }
        }
        return false;
    }

    // scroll-wheel zoom (support both wheel and legacy mousewheel)
    if ((event.type === "wheel" || event.type === "mousewheel") && lx >= 0 && lx <= W && ly >= TOOLBAR_H && ly <= innerH) {
        const dy = event.deltaY ?? (event.wheelDelta ? -event.wheelDelta : 0);
        if (dy !== 0) {
            const delta = dy > 0 ? -0.15 : 0.15;
            const pivot = pxToTime(lx);
            st.zoom = Math.max(1.0, Math.min(50.0, st.zoom * (1 + delta)));
            const newVisD = d / st.zoom;
            st.scrollOffset = Math.max(0, Math.min(d - newVisD, pivot - (lx / W) * newVisD));
            node.setDirtyCanvas(true, false);
            event.preventDefault?.();
            return true;
        }
    }

    // cursor shape hint
    if (event.type === "pointermove" && !st.dragging) {
        if (lx >= 0 && lx <= W && ly >= TOOLBAR_H && ly <= innerH) {
            st.hoverX = lx;
            const nearStart = Math.abs(lx - sxPx) <= MARKER_HIT;
            const nearEnd   = Math.abs(lx - exPx) <= MARKER_HIT;
            const inRegion  = lx > sxPx + MARKER_HIT && lx < exPx - MARKER_HIT;
            if (nearStart || nearEnd) {
                document.body.style.cursor = "col-resize";
            } else if (inRegion) {
                document.body.style.cursor = "grab";
            } else {
                document.body.style.cursor = "";
            }
        } else {
            st.hoverX = null;
            document.body.style.cursor = "";
        }
        node.setDirtyCanvas(true, false);
    }

    if (event.type === "pointerleave") {
        st.hoverX = null;
        document.body.style.cursor = "";
        node.setDirtyCanvas(true, false);
    }

    if (!st.peaks) return false;

    // pointer up
    if (event.type === "pointerup") {
        if (st.dragging === "start" || st.dragging === "end") {
            const name = st.dragging === "start" ? "start_sec" : "end_sec";
            const wid  = node.widgets?.find(x => x.name === name);
            if (wid) {
                wid.value = Math.round(snapToZeroCrossing(st.audioBuffer, wid.value) * 100) / 100;
                wid.callback?.(wid.value);
            }
        }
        if (st.dragging === "region_pending") {
            if (st.playSource) {
                try { st.playSource.stop(); } catch (_) {}
                st.playSource = null;
                if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
            }
            st.scrubTime = Math.max(0, Math.min(d, pxToTime(lx)));
        }
        st.dragging = null;
        document.body.style.cursor = "";
        node.setDirtyCanvas(true, true);
        return false;
    }

    if (lx < 0 || lx > W || ly < TOOLBAR_H || ly > innerH) return false;

    // pointer down → decide: scrub cursor, start/end marker, region drag
    if (event.type === "pointerdown") {
        const nearStart = Math.abs(lx - sxPx) <= MARKER_HIT;
        const nearEnd   = Math.abs(lx - exPx) <= MARKER_HIT;
        const scrubPx   = st.scrubTime !== null ? timeToPx(st.scrubTime) : -999;
        const nearScrub = st.scrubTime !== null && Math.abs(lx - scrubPx) <= MARKER_HIT;
        const inRegion  = lx > sxPx + MARKER_HIT && lx < exPx - MARKER_HIT;

        if (nearStart && nearEnd) {
            st.dragging = lx <= sxPx ? "start" : "end";
            st.activeMarker = st.dragging;
        } else if (nearStart) {
            st.dragging = "start";
            st.activeMarker = "start";
        } else if (nearEnd) {
            st.dragging = "end";
            st.activeMarker = "end";
        } else if (nearScrub) {
            st.dragging = "scrub";
        } else if (inRegion) {
            st.dragging = "region_pending";
            st._clickOriginPx = lx;
            st._regionAnchorTime = pxToTime(lx);
            st._regionStartOrig = sv;
            st._regionEndOrig   = eActual;
        } else {
            if (st.playSource) {
                try { st.playSource.stop(); } catch (_) {}
                st.playSource = null;
                if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
            }
            st.scrubTime = Math.max(0, Math.min(d, pxToTime(lx)));
            st.dragging = "scrub";
        }
    }

    // pointer move while dragging
    if (st.dragging && (event.type === "pointermove" || event.type === "pointerdown")) {
        const t = Math.max(0, Math.min(d, pxToTime(lx)));

        if (st.dragging === "scrub") {
            st.scrubTime = Math.max(0, Math.min(d, pxToTime(lx)));
            node.setDirtyCanvas(true, false);
            return true;
        }

        if (st.dragging === "region_pending") {
            if (Math.abs(lx - st._clickOriginPx) > 3) {
                st.dragging = "region";
            } else {
                return true;
            }
        }

        if (st.dragging === "region") {
            const delta = t - st._regionAnchorTime;
            let newS = st._regionStartOrig + delta;
            let newE = st._regionEndOrig   + delta;
            if (newS < 0) { newE -= newS; newS = 0; }
            if (newE > d) { newS -= (newE - d); newE = d; }
            const ws = node.widgets?.find(x => x.name === "start_sec");
            const we = node.widgets?.find(x => x.name === "end_sec");
            if (ws) { ws.value = Math.round(Math.max(0, newS) * 100) / 100; ws.callback?.(ws.value); }
            if (we) { we.value = Math.round(Math.min(d, newE) * 100) / 100; we.callback?.(we.value); }
        } else {
            const name = st.dragging === "start" ? "start_sec" : "end_sec";
            const wid  = node.widgets?.find(x => x.name === name);
            if (wid) {
                let clamped = t;
                if (st.dragging === "start") clamped = Math.min(clamped, eActual - 0.01);
                else                         clamped = Math.max(clamped, sv + 0.01);
                wid.value = Math.round(clamped * 100) / 100;
                wid.callback?.(wid.value);
            }
        }
        node.setDirtyCanvas(true, true);
        return true;
    }

    return false;
}

// ─── play / stop ──────────────────────────────────────────────────────────────

function doPlay(node, st) {
    if (st.playSource) {
        try {
            if (st.audioCtx) {
                const el = st.audioCtx.currentTime - st.playStartAt;
                st.scrubTime = st.playOffset + Math.min(el, st.playDuration);
            }
            st.playSource.stop();
        } catch (_) {}
        st.playSource = null;
        if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
        node.setDirtyCanvas(true, true);
        return;
    }
    if (!st.audioBuffer) return;
    try {
        if (!st.audioCtx) st.audioCtx = new AudioContext();
        if (st.audioCtx.state === "suspended") st.audioCtx.resume();

        const s   = node.widgets?.find(x => x.name === "start_sec")?.value ?? 0;
        const ev  = node.widgets?.find(x => x.name === "end_sec")?.value ?? -1;
        const e   = ev < 0 ? st.audioBuffer.duration : ev;

        // If scrub cursor is inside the selection, start from there; otherwise from s.
        const playFrom = (st.scrubTime !== null && st.scrubTime >= s && st.scrubTime < e)
            ? st.scrubTime : s;
        let isFirstSegment = true;

        function startSegment(from) {
            const offset  = from ?? s;
            const dur     = Math.max(0.01, e - offset);
            const src     = st.audioCtx.createBufferSource();
            src.buffer    = st.audioBuffer;
            src.connect(st.audioCtx.destination);

            st.playOffset   = offset;
            st.playDuration = dur;
            st.playStartAt  = st.audioCtx.currentTime;

            src.start(0, offset, dur);
            st.playSource = src;

            src.onended = () => {
                if (st.looping && st.playSource === src) {
                    startSegment(s);
                } else {
                    if (st.audioCtx) {
                        const el = st.audioCtx.currentTime - st.playStartAt;
                        st.scrubTime = st.playOffset + Math.min(el, st.playDuration);
                    }
                    st.playSource = null;
                    if (st.rafId) { cancelAnimationFrame(st.rafId); st.rafId = null; }
                    node.setDirtyCanvas(true, true);
                }
            };
        }

        startSegment(playFrom);

        const tick = () => {
            if (!st.playSource) return;
            node.setDirtyCanvas(true, false);
            st.rafId = requestAnimationFrame(tick);
        };
        st.rafId = requestAnimationFrame(tick);

        node.setDirtyCanvas(true, true);
    } catch (e) { console.warn("[AudioTools] play error:", e); }
}

// ─── upstream Load Audio / combo: stable id for dedupe + view URL ─────────────

function audioSourceFingerprint(val) {
    if (val == null) return "";
    if (typeof val === "object") {
        try {
            return JSON.stringify({
                filename: val.filename,
                subfolder: val.subfolder ?? "",
                type: val.type ?? "input",
            });
        } catch (_) {
            return String(val.filename ?? val);
        }
    }
    return String(val);
}

function viewUrlForAudioVal(val) {
    let filename = val;
    let subfolder = "";
    if (val && typeof val === "object") {
        filename = val.filename;
        subfolder = val.subfolder ?? "";
    }
    const params = new URLSearchParams({ type: "input" });
    if (filename != null) params.set("filename", filename);
    if (subfolder) params.set("subfolder", subfolder);
    return `/view?${params.toString()}`;
}

function getAppGraph() {
    return app.graph || app.canvas?.graph || null;
}

function getGraphLink(linkId) {
    const L = getAppGraph()?.links;
    if (L == null || linkId == null) return null;
    if (typeof L.get === "function") return L.get(linkId);
    return L[linkId];
}

function linkOutputNodeId(link) {
    if (!link) return null;
    return link.origin_id ?? link.origin ?? null;
}

/** Find file combo on Load Audio (widget names differ across ComfyUI builds). */
function findAudioFileWidget(srcNode) {
    if (!srcNode || !Array.isArray(srcNode.widgets)) return null;
    const names = ["audio", "audio_file", "file", "path", "upload"];
    for (const n of names) {
        const w = srcNode.widgets.find((x) => x.name === n);
        if (w) return w;
    }
    const cls = String(srcNode.comfyClass || srcNode.type || "");
    if (cls.includes("LoadAudio") || cls === "LoadAudio") {
        const combo = srcNode.widgets.find(
            (x) =>
                x.type === "combo" ||
                (Array.isArray(x.options) && x.options.length) ||
                x.type === "text"
        );
        if (combo) return combo;
    }
    return srcNode.widgets.find((x) => x.type === "combo") || null;
}

function scheduleReload(node, st, ms = 50) {
    if (st._reloadTimer) clearTimeout(st._reloadTimer);
    st._reloadTimer = setTimeout(() => {
        st._reloadTimer = null;
        loadAudio(node, st, true);
    }, ms);
}

function teardownTrimAudioWatchers(st) {
    if (typeof st._restoreWidgetCallback === "function") {
        try { st._restoreWidgetCallback(); } catch (_) {}
        st._restoreWidgetCallback = null;
    }
    if (st._pollId) {
        clearInterval(st._pollId);
        st._pollId = null;
    }
    if (st._reloadTimer) {
        clearTimeout(st._reloadTimer);
        st._reloadTimer = null;
    }
    if (typeof st._apiUnhook === "function") {
        try { st._apiUnhook(); } catch (_) {}
        st._apiUnhook = null;
    }
}

/** Callback + polling + post-exec events (file changes without widget callback still detected). */
function bindUpstreamAudioWidget(node, st) {
    teardownTrimAudioWatchers(st);

    const linkId = node.inputs?.[0]?.link;
    if (!linkId) return;

    const graphLink = getGraphLink(linkId);
    if (!graphLink) return;

    const srcNode = getAppGraph()?.getNodeById(linkOutputNodeId(graphLink));
    if (!srcNode) return;

    const audioWidget = findAudioFileWidget(srcNode);
    if (!audioWidget) return;

    const fire = () => scheduleReload(node, st, 30);
    const prevCb = audioWidget.callback;
    audioWidget.callback = function () {
        if (typeof prevCb === "function") prevCb.apply(this, arguments);
        fire();
    };
    st._restoreWidgetCallback = () => {
        audioWidget.callback = prevCb;
    };

    st._pollId = setInterval(() => {
        try {
            if (!node.inputs?.[0]?.link || st.loading) return;
            const gl = getGraphLink(node.inputs[0].link);
            if (!gl) return;
            const sn = getAppGraph()?.getNodeById(linkOutputNodeId(gl));
            const w = findAudioFileWidget(sn);
            if (!w) return;
            const fp = audioSourceFingerprint(w.value);
            if (fp && fp !== st.lastSourceKey) scheduleReload(node, st, 40);
        } catch (_) {}
    }, 300);

    const api = window.comfyAPI?.api;
    const onExec = () => {
        // Reload only when upstream file actually changed (force=false).
        if (!node.inputs?.[0]?.link || st.loading) return;
        if (st._reloadTimer) clearTimeout(st._reloadTimer);
        st._reloadTimer = setTimeout(() => {
            st._reloadTimer = null;
            loadAudio(node, st, false);
        }, 200);
    };
    if (api?.addEventListener) {
        api.addEventListener("executed", onExec);
        api.addEventListener("execution_success", onExec);
        st._apiUnhook = () => {
            try {
                api.removeEventListener("executed", onExec);
                api.removeEventListener("execution_success", onExec);
            } catch (_) {}
        };
    }
}

// ─── load audio ───────────────────────────────────────────────────────────────

/**
 * @param {boolean} force — true after user changes upstream file or cable (skip fingerprint dedupe).
 */
async function loadAudio(node, st, force = false) {
    try {
        const linkId = node.inputs?.[0]?.link;
        if (!linkId) {
            st.audioBuffer = null; st.peaks = null; st.lastSourceKey = null;
            teardownTrimAudioWatchers(st);
            node.setDirtyCanvas(true, true);
            return;
        }

        const graphLink = getGraphLink(linkId);
        if (!graphLink) return;

        const srcNode = getAppGraph()?.getNodeById(linkOutputNodeId(graphLink));
        if (!srcNode) return;

        const audioWidget = findAudioFileWidget(srcNode);
        if (!audioWidget) {
            st.audioBuffer = null; st.peaks = null; st.lastSourceKey = null;
            node.setDirtyCanvas(true, true);
            return;
        }

        const val = audioWidget.value;
        const fingerprint = audioSourceFingerprint(val);
        if (!fingerprint) {
            st.audioBuffer = null; st.peaks = null; st.lastSourceKey = null;
            node.setDirtyCanvas(true, true);
            return;
        }
        if (!force && fingerprint === st.lastSourceKey) return;

        st.lastSourceKey = fingerprint;
        st.loading = true;
        node.setDirtyCanvas(true, true);

        if (!st.audioCtx) st.audioCtx = new AudioContext();

        let url = viewUrlForAudioVal(val);
        if (force) url += (url.includes("?") ? "&" : "?") + "_t=" + Date.now();
        const resp = await fetch(url, { cache: "no-store" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const arrayBuf = await resp.arrayBuffer();
        st.audioBuffer = await st.audioCtx.decodeAudioData(arrayBuf);
        const numBars = Math.max(500, Math.floor((node.size[0] - PAD * 2) * 3));
        st.peaks = buildPeaks(st.audioBuffer, numBars);

        st.zoom = 1.0;
        st.scrollOffset = 0.0;
        st.scrubTime = 0;

        const d = st.audioBuffer.duration;
        const ws = node.widgets?.find((w) => w.name === "start_sec");
        const we = node.widgets?.find((w) => w.name === "end_sec");
        if (ws && d > 0 && ws.value > d) {
            ws.value = 0;
            ws.callback?.(ws.value);
        }
        if (we && d > 0 && we.value >= 0 && we.value > d) {
            we.value = Math.round(d * 100) / 100;
            we.callback?.(we.value);
        }

    } catch (err) {
        console.warn("[AudioTools] loadAudio error:", err);
        st.audioBuffer = null; st.peaks = null;
        st.lastSourceKey = null;
    } finally {
        st.loading = false;
        node.setDirtyCanvas(true, true);
    }
}
