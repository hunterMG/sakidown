/**
 * @file background/danmaku-converter.js
 * @description XML 弹幕转 ASS 字幕转换器
 * * 核心职责:
 * 1. 解析 bilibili XML 弹幕格式 (<d> 标签)
 * 2. 碰撞检测与位置分配 (R2L 滚动 / Fix 固定)
 * 3. 生成 ASS 字幕文本
 * @author weiyunjun
 * @version v0.1.0
 */

const DEFAULT_CONFIG = {
    playResX: 560,
    playResY: 420,
    r2lTime: 8,
    fixTime: 4,
    opacity: 0.6,
    maxDelay: 6,
    bottomReserve: 50,
};

function detectFont() {
    const platform = navigator.platform || '';
    if (platform.includes('Mac')) return 'PingFang SC';
    if (platform.includes('Win')) return 'Microsoft YaHei';
    return 'Noto Sans CJK SC';
}

export function convertDanmakuToAss(xmlText, userConfig = {}) {
    const cfg = { ...DEFAULT_CONFIG, ...userConfig };
    const { playResX, playResY, r2lTime, fixTime, opacity, maxDelay, bottomReserve } = cfg;
    const fontName = cfg.fontName || detectFont();

    // ===== 工具函数 =====
    const toHex6 = (n) => ('000000' + (n & 0xffffff).toString(16).toUpperCase()).slice(-6);
    const toAlpha = (o) => ('00' + Math.round(0xFF * (1 - o)).toString(16).toUpperCase()).slice(-2);
    const estimateWidth = (text, fs) => {
        let w = 0;
        for (let i = 0; i < text.length; i++) w += text.charCodeAt(i) > 127 ? fs : fs / 2;
        return w;
    };
    const formatTime = (sec) => {
        let cs = Math.floor(sec * 100);
        const c = cs % 100; cs = (cs - c) / 100;
        const s = cs % 60; cs = (cs - s) / 60;
        const m = cs % 60; const h = (cs - m) / 60;
        return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
    };
    const escapeAss = (s) => s.replace(/{/g, '｛').replace(/}/g, '｝').replace(/\r|\n/g, '');
    const hypot = Math.hypot || ((a, b) => Math.sqrt(a * a + b * b));

    // ===== 1. 解析 XML =====
    const danmaku = [];
    const cleaned = xmlText.replace(/[\x00-\x08\x0B\f\x0E-\x1F\uFFFE\uFFFF]/g, '');
    const RE = /<d p="([^"]+)">([\s\S]*?)<\/d>/g;
    let mt;
    while ((mt = RE.exec(cleaned)) !== null) {
        const p = mt[1].split(',');
        const text = mt[2].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
        const mode = { 1: 'R2L', 2: 'R2L', 3: 'R2L', 4: 'BOTTOM', 5: 'TOP' }[Number(p[1])];
        if (!mode || !text) continue;
        danmaku.push({ text, time: Number(p[0]), mode, size: Number(p[2]), color: toHex6(parseInt(p[3], 10)), bottom: Number(p[5]) > 0 });
    }
    danmaku.sort((a, b) => a.time - b.time);

    // ===== 2. R2L 碰撞检测 =====
    const r2l = [
        { p: -Infinity, m: 0, tf: Infinity, td: Infinity, b: false },
        { p: playResY, m: Infinity, tf: Infinity, td: Infinity, b: false },
        { p: playResY - bottomReserve, m: playResY, tf: Infinity, td: Infinity, b: true },
    ];
    const placeR2L = (t0s, wv, hv, bf) => {
        const t0l = playResX / (wv + playResX) * r2lTime + t0s;
        for (let i = r2l.length - 1; i >= 3; i--) {
            if (r2l[i].tf <= t0s && r2l[i].td <= t0l) r2l.splice(i, 1);
        }
        const cands = [];
        for (const sl of r2l) {
            if (sl.m > playResY) continue;
            const top = sl.m, bot = top + hv;
            let tas = t0s, tal = t0l;
            for (const o of r2l) {
                if (o.p >= bot || o.m <= top) continue;
                if (o.b && bf) continue;
                tas = Math.max(tas, o.tf);
                tal = Math.max(tal, o.td);
            }
            cands.push({ p: top, r: Math.max(tas - t0s, tal - t0l) });
        }
        cands.sort((a, b) => a.p - b.p);
        let minR = maxDelay;
        const valid = cands.filter(c => { if (c.r >= minR) return false; minR = c.r; return true; });
        if (!valid.length) return null;
        const best = valid.reduce((b, c) => {
            const sc = 1 - hypot(c.r / maxDelay, c.p / playResY) * Math.SQRT1_2;
            return sc > b.sc ? { ...c, sc } : b;
        }, { sc: -Infinity });
        const ts = t0s + best.r;
        r2l.push({ p: best.p, m: best.p + hv, tf: wv / (wv + playResX) * r2lTime + ts, td: r2lTime + ts, b: false });
        return { top: best.p, time: ts };
    };

    // ===== 2b. Fix 碰撞检测 =====
    const fix = [
        { p: -Infinity, m: 0, td: Infinity, b: false },
        { p: playResY, m: Infinity, td: Infinity, b: false },
        { p: playResY - bottomReserve, m: playResY, td: Infinity, b: true },
    ];
    const placeFix = (t0s, hv, isTop, bf) => {
        for (let i = fix.length - 1; i >= 3; i--) {
            if (fix[i].td <= t0s) fix.splice(i, 1);
        }
        const cands = [];
        for (const sl of fix) {
            let top, bot;
            if (isTop) { if (sl.m > playResY) continue; top = sl.m; bot = top + hv; }
            else { if (sl.p < 0) continue; top = sl.p - hv; bot = sl.p; }
            let tas = t0s;
            for (const o of fix) {
                if (o.p >= bot || o.m <= top) continue;
                if (o.b && bf) continue;
                tas = Math.max(tas, o.td);
            }
            cands.push({ p: top, m: bot, r: tas - t0s });
        }
        let minR = maxDelay;
        const valid = cands.filter(c => { if (c.r >= minR) return false; minR = c.r; return true; });
        if (!valid.length) return null;
        const best = valid.reduce((b, c) => {
            const pv = isTop ? c.p : (playResY - c.p);
            const sc = 1 - (c.r / maxDelay * (31 / 32) + pv / playResY * (1 / 32));
            return sc > b.sc ? { ...c, sc } : b;
        }, { sc: -Infinity });
        fix.push({ p: best.p, m: best.m, td: best.r + t0s + fixTime, b: false });
        return { top: best.p, time: best.r + t0s };
    };

    // ===== 3. 分配位置 =====
    const events = [];
    for (const d of danmaku) {
        const fontSize = Math.round(d.size);
        const width = estimateWidth(d.text, fontSize);
        let pos;
        if (d.mode === 'R2L') {
            pos = placeR2L(d.time, width, fontSize, d.bottom);
            if (!pos) continue;
            events.push({
                type: 'R2L', stime: pos.time, dtime: r2lTime + pos.time,
                text: d.text, size: d.size, color: d.color,
                poss: { x: playResX + width / 2, y: pos.top + fontSize },
                posd: { x: -width / 2, y: pos.top + fontSize },
            });
        } else {
            pos = placeFix(d.time, fontSize, d.mode === 'TOP', d.bottom);
            if (!pos) continue;
            events.push({
                type: 'Fix', stime: pos.time, dtime: fixTime + pos.time,
                text: d.text, size: d.size, color: d.color,
                poss: { x: Math.round(playResX / 2), y: pos.top + fontSize },
            });
        }
    }
    events.sort((a, b) => a.stime - b.stime);

    // ===== 4. 生成 ASS =====
    const alpha = toAlpha(opacity);
    const header = [
        '[Script Info]',
        'Title: SakiDown ASS 弹幕转换',
        'ScriptType: v4.00+',
        'Collisions: Normal',
        `PlayResX: ${playResX}`,
        `PlayResY: ${playResY}`,
        'Timer: 10.0000',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Fix,${fontName},25,&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}000000,&H${alpha}000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,2,0`,
        `Style: R2L,${fontName},25,&H${alpha}FFFFFF,&H${alpha}FFFFFF,&H${alpha}000000,&H${alpha}000000,0,0,0,0,100,100,0,0,1,1,0,2,20,20,2,0`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ].join('\n') + '\n';

    const lines = events.map(ev => {
        let fx = ev.type === 'R2L'
            ? `\\move(${ev.poss.x},${ev.poss.y},${ev.posd.x},${ev.posd.y})`
            : `\\pos(${ev.poss.x},${ev.poss.y})`;
        if (ev.color !== 'FFFFFF') {
            fx += `\\c&H${ev.color.slice(4, 6)}${ev.color.slice(2, 4)}${ev.color.slice(0, 2)}`;
        }
        const rgb = [0, 2, 4].map(i => parseInt(ev.color.slice(i, i + 2), 16));
        if (rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114 < 0x30) {
            fx += '\\3c&HFFFFFF';
        }
        if (ev.size !== 25) fx += `\\fs${Math.round(ev.size)}`;
        return `Dialogue: 0,${formatTime(ev.stime)},${formatTime(ev.dtime)},${ev.type},,20,20,2,,{${fx}}${escapeAss(ev.text)}`;
    });

    return header + lines.join('\n');
}