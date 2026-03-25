const { app } = window.comfyAPI.app;

const WAVE_H  = 140;
const PAD     = 8;
const LABEL_H = 18;
const MARKER_HIT = 8;   // px zone for grab detection
const FRAME_STEP_KEYS = { ArrowLeft: -1, ArrowRight: 1 };

// ─── helpers ──────────────────────────────────────────────────────────────────

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
        lastFile     : null,
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
        const h = WAVE_H - LABEL_H;
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
            const h  = WAVE_H - LABEL_H;
            const x0 = PAD;

            ctx.save();

            ctx.fillStyle = "#181820";
            ctx.fillRect(x0, y, W, h);
            ctx.strokeStyle = "#333344";
            ctx.lineWidth = 1;
            ctx.strokeRect(x0, y, W, h);

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
                ctx.fillText("Loading waveform…", x0 + W / 2, y + h / 2 + 4);

            } else if (st.peaks) {
                const { max, min } = st.peaks;
                const midY  = y + h / 2;
                const halfH = h / 2 - 4;

                // selected zone
                const selL = Math.max(x0, sx);
                const selR = Math.min(x0 + W, ex);
                if (selR > selL) {
                    ctx.fillStyle = "rgba(72,210,100,0.10)";
                    ctx.fillRect(selL, y, selR - selL, h);
                }

                // waveform as filled polygon (classic DAW style)
                ctx.save();
                ctx.beginPath();
                ctx.rect(x0, y, W, h);
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
                    ctx.rect(selL, y, selR - selL, h);
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
                ctx.fillText("Connect audio input to see waveform", x0 + W / 2, y + h / 2 + 4);
            }

            // start marker
            if (sx >= x0 - 2 && sx <= x0 + W + 2) {
                ctx.strokeStyle = "#ffd200"; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(sx, y); ctx.lineTo(sx, y + h); ctx.stroke();
                ctx.fillStyle = "#ffd200";
                ctx.beginPath(); ctx.moveTo(sx, y); ctx.lineTo(sx + 9, y + 11); ctx.lineTo(sx, y + 11);
                ctx.closePath(); ctx.fill();
            }

            // end marker
            if (ex >= x0 - 2 && ex <= x0 + W + 2) {
                ctx.strokeStyle = "#ff6440"; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(ex, y); ctx.lineTo(ex, y + h); ctx.stroke();
                ctx.fillStyle = "#ff6440";
                ctx.beginPath(); ctx.moveTo(ex, y); ctx.lineTo(ex - 9, y + 11); ctx.lineTo(ex, y + 11);
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
                const ly  = y + 6;

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
                    ctx.moveTo(hx, y);
                    ctx.lineTo(hx, y + h);
                    ctx.stroke();
                    ctx.setLineDash([]);

                    const lbl = fmt(sec);
                    ctx.font = "10px monospace";
                    const tw  = ctx.measureText(lbl).width + 6;
                    const lx  = Math.min(hx + 4, x0 + W - tw - 2);
                    const ly  = y + h - 16;

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
                        ctx.moveTo(cx, y);
                        ctx.lineTo(cx, y + h);
                        ctx.stroke();
                        ctx.fillStyle = "rgba(255,255,255,0.85)";
                        ctx.beginPath();
                        ctx.arc(cx, y + h / 2, 4, 0, Math.PI * 2);
                        ctx.fill();
                    }
                    if (st.playSource) {
                        ctx.fillStyle = "rgba(40,40,50,0.80)";
                        ctx.fillRect(x0 + 2, y + h - 16, 64, 14);
                        ctx.fillStyle = "#eee";
                        ctx.font = "10px monospace";
                        ctx.textAlign = "left";
                        ctx.fillText(fmt(curT), x0 + 5, y + h - 5);
                    }
                }
            }

            // ── play/stop button ──────────────────────────────────────────────
            const btnW = 30, btnH = 18, btnX = x0 + W - btnW - 2, btnY = y + 3;
            ctx.fillStyle   = st.playSource ? "#882222" : "#1e6632";
            ctx.fillRect(btnX, btnY, btnW, btnH);
            ctx.strokeStyle = st.playSource ? "#ff5555" : "#48d264";
            ctx.lineWidth = 1; ctx.strokeRect(btnX, btnY, btnW, btnH);
            ctx.fillStyle = "#fff";
            ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center";
            ctx.fillText(st.playSource ? "■" : "▶", btnX + btnW / 2, btnY + 13);

            // ── loop toggle ───────────────────────────────────────────────────
            const loopX = btnX - 24, loopY = btnY;
            ctx.fillStyle   = st.looping ? "#1e5566" : "rgba(40,40,50,0.5)";
            ctx.fillRect(loopX, loopY, 20, btnH);
            ctx.strokeStyle = st.looping ? "#44ccdd" : "#556";
            ctx.lineWidth = 1; ctx.strokeRect(loopX, loopY, 20, btnH);
            ctx.fillStyle = st.looping ? "#44ccdd" : "#889";
            ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
            ctx.fillText("⟳", loopX + 10, loopY + 13);

            // ── zoom controls (zoom label / − / +) ───────────────────────────
            const zmY = y + 3;
            const plusX  = loopX - 24;
            const minusX = loopX - 46;
            const resetW = 34;
            const resetX = loopX - 46 - resetW - 2;
            const zLabel = z > 1.05 ? `\u00d7${z.toFixed(1)}` : "1\u00d7";
            // label/reset button — shows live zoom, click to reset
            ctx.fillStyle = z > 1.05 ? "rgba(30,60,70,0.9)" : "rgba(40,40,50,0.8)";
            ctx.fillRect(resetX, zmY, resetW, btnH);
            ctx.strokeStyle = z > 1.05 ? "#44ccdd" : "#556";
            ctx.lineWidth = 1; ctx.strokeRect(resetX, zmY, resetW, btnH);
            ctx.fillStyle = z > 1.05 ? "#44ccdd" : "#aac";
            ctx.font = "bold 10px monospace"; ctx.textAlign = "center";
            ctx.fillText(zLabel, resetX + resetW / 2, zmY + 13);
            // − button
            ctx.fillStyle = "rgba(40,40,50,0.8)";
            ctx.fillRect(minusX, zmY, 20, btnH);
            ctx.strokeStyle = "#556";
            ctx.lineWidth = 1; ctx.strokeRect(minusX, zmY, 20, btnH);
            ctx.fillStyle = "#ccd";
            ctx.font = "bold 13px monospace"; ctx.textAlign = "center";
            ctx.fillText("\u2212", minusX + 10, zmY + 13);
            // + button
            ctx.fillStyle = "rgba(40,40,50,0.8)";
            ctx.fillRect(plusX, zmY, 20, btnH);
            ctx.strokeStyle = "#556";
            ctx.lineWidth = 1; ctx.strokeRect(plusX, zmY, 20, btnH);
            ctx.fillStyle = "#ccd";
            ctx.fillText("+", plusX + 10, zmY + 13);

            // ── zoom indicator ────────────────────────────────────────────────
            if (z > 1.05) {
                ctx.fillStyle = "rgba(40,40,50,0.80)";
                ctx.fillRect(x0 + W - 60, y + h - 16, 58, 14);
                ctx.fillStyle = "#aab";
                ctx.font = "9px monospace"; ctx.textAlign = "right";
                ctx.fillText(`×${z.toFixed(1)}`, x0 + W - 4, y + h - 5);
            }

            // ── bottom labels ─────────────────────────────────────────────────
            const labY = y + h + LABEL_H - 4;
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
            const h = WAVE_H - LABEL_H;
            if (localX < 0 || localX > W || localY < 0 || localY > h) return;
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
        if (!st.audioBuffer) return;
        const d   = st.audioBuffer.duration;
        const fps = node.widgets?.find(x => x.name === "fps")?.value ?? 24;

        if (e.key === " ") {
            e.preventDefault();
            doPlay(node, st);
            return true;
        }
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

    // ── connection change ──────────────────────────────────────────────────────
    const origConn = node.onConnectionsChange;
    node.onConnectionsChange = function(type, slotIndex, connected) {
        try { origConn?.apply(this, arguments); } catch (_) {}
        if (type === 1 && slotIndex === 0) {
            setTimeout(() => loadAudio(node, st), 300);
        }
    };

    setTimeout(() => loadAudio(node, st), 700);
}

// ─── mouse handler ────────────────────────────────────────────────────────────

function handleMouse(event, pos, node, st, ww) {
    const W  = node.size[0] - PAD * 2;
    const h  = WAVE_H - LABEL_H;
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

    // play button
    const btnW = 30, btnH = 18, btnX = W - btnW - 2, btnY = 3;
    if (event.type === "pointerdown" &&
        lx >= btnX && lx <= btnX + btnW &&
        ly >= btnY && ly <= btnY + btnH) {
        doPlay(node, st);
        return true;
    }

    // loop toggle
    const loopX = btnX - 24, loopY = btnY;
    if (event.type === "pointerdown" &&
        lx >= loopX && lx <= loopX + 20 &&
        ly >= loopY && ly <= loopY + btnH) {
        st.looping = !st.looping;
        node.setDirtyCanvas(true, false);
        return true;
    }

    // zoom buttons (label-reset / − / +) independent from wheel events
    const plusX   = loopX - 24;
    const minusX  = loopX - 46;
    const resetW  = 34;
    const resetX  = loopX - 46 - resetW - 2;
    if (event.type === "pointerdown" && ly >= btnY && ly <= btnY + btnH) {
        const d = st.audioBuffer?.duration ?? 1;
        if (lx >= minusX && lx <= minusX + 20) {
            const center = st.scrollOffset + (d / st.zoom) * 0.5;
            st.zoom = Math.max(1.0, st.zoom / 1.3);
            const vis = d / st.zoom;
            st.scrollOffset = Math.max(0, Math.min(d - vis, center - vis * 0.5));
            node.setDirtyCanvas(true, false);
            return true;
        }
        if (lx >= plusX && lx <= plusX + 20) {
            const center = st.scrollOffset + (d / st.zoom) * 0.5;
            st.zoom = Math.min(50.0, st.zoom * 1.3);
            const vis = d / st.zoom;
            st.scrollOffset = Math.max(0, Math.min(d - vis, center - vis * 0.5));
            node.setDirtyCanvas(true, false);
            return true;
        }
        if (lx >= resetX && lx <= resetX + resetW) {
            st.zoom = 1.0;
            st.scrollOffset = 0.0;
            node.setDirtyCanvas(true, false);
            return true;
        }
    }

    // scroll-wheel zoom (support both wheel and legacy mousewheel)
    if ((event.type === "wheel" || event.type === "mousewheel") && lx >= 0 && lx <= W && ly >= 0 && ly <= h) {
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
        if (lx >= 0 && lx <= W && ly >= 0 && ly <= h) {
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

    if (lx < 0 || lx > W || ly < 0 || ly > h) return false;

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

// ─── load audio ───────────────────────────────────────────────────────────────

async function loadAudio(node, st) {
    try {
        const linkId = node.inputs?.[0]?.link;
        if (!linkId) {
            st.audioBuffer = null; st.peaks = null; st.lastFile = null;
            node.setDirtyCanvas(true, true);
            return;
        }

        const graphLink = app.graph.links[linkId];
        if (!graphLink) return;

        const srcNode = app.graph.getNodeById(graphLink.origin_id);
        if (!srcNode) return;

        const audioWidget = srcNode.widgets?.find(w => w.name === "audio");
        if (!audioWidget) return;

        const val      = audioWidget.value;
        const filename = typeof val === "object" ? val?.filename : val;
        if (!filename || filename === st.lastFile) return;

        st.lastFile = filename;
        st.loading  = true;
        node.setDirtyCanvas(true, true);

        if (!st.audioCtx) st.audioCtx = new AudioContext();

        const resp = await fetch(`/view?filename=${encodeURIComponent(filename)}&type=input`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const arrayBuf = await resp.arrayBuffer();
        st.audioBuffer = await st.audioCtx.decodeAudioData(arrayBuf);
        const numBars  = Math.max(500, Math.floor((node.size[0] - PAD * 2) * 3));
        st.peaks       = buildPeaks(st.audioBuffer, numBars);

        st.zoom        = 1.0;
        st.scrollOffset = 0.0;
        st.scrubTime   = 0;

    } catch (err) {
        console.warn("[AudioTools] loadAudio error:", err);
        st.audioBuffer = null; st.peaks = null;
    } finally {
        st.loading = false;
        node.setDirtyCanvas(true, true);
    }
}
