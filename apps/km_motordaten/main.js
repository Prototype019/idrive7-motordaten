'use strict';
/**
 * Motordaten fuer BMW iDrive 7 (MGU), auch ID8 - dieselbe App wie die M2-Version
 * (Prototype019/motordaten, iDrive 8), nur auf dem MGU App Kit (kit/, MIT).
 *
 * Das Design ist 1:1 die ID8-App: dash.js zeichnet die Seiten (2880x764), wir
 * passen sie in den ID7-Bildbereich (1600x520) ein und uebergeben das Bild.
 * Werte liest es per UDS-Diagnose (0x22) aus der DME (0x12), dem Getriebe
 * (EGS 0x18) und einer OBD-PID - ueber kit/diag.js, dekodiert mit decode.js
 * (DME8FF_R, B58). Fehlerspeicher wird nur gelesen (19 02). NUR LESEND: die
 * Schreib-Aktionen der M2-App (Max Cooling, Fehlerspeicher loeschen) sind aus.
 *
 * iDrive-7-Laufzeit = Node 8: kein ?./??/Spread/import/Klassenfelder.
 */
var mgu = require('./kit/mgu');
var Car = require('./kit/car');
var Diag = require('./kit/diag').Diag;

var dash = require('./dash.js');
var decode = require('./decode.js');
var Limits = require('./limits.js');
var KitCanvas = require('./kit_canvas.js').Canvas;
var clock = require('./clock.js');
var Records = require('./records.js').Records;
var logbook = require('./logbook.js');
var faults = require('./faults.js');

var DME = 0x12, EGS = 0x18;
var HOLD_MS = 4000, RPM_RUN = 400, PEAK_AFTER_MS = 5000, GLIDE_MS = 90;
var CYCLE_MS = 250;
var SW = dash.W, SH = dash.H;          // 2880 x 764 (dash.js)

// DID-Gruppen (Benziner G-Serie, DME8FF_R = G20 B58). Ids -> decode.js-Tabellen.
var FAST = [0x4807, 0x5891, 0x4205, 0x4AB0, 0x4436, 0x4ABC, 0x5813];
var SLOW = [0x580F, 0x4201, 0x582F, 0x4402, 0x4300, 0x59D4];
var KNOCK = [0x554C, 0x4A49, 0x4A4A, 0x4A4C, 0x4A4D, 0x4A4E, 0x4A4F];
var BATTERY = [0x5425];

var KEYOF = {
    0x4807: 'rpm', 0x5891: 'torque', 0x4205: 'boostAbs', 0x4AB0: 'boostTargetAbs',
    0x4436: 'oilPressAbs', 0x4ABC: 'airMass', 0x5813: 'load',
    0x580F: 'intake', 0x4201: 'ambient', 0x582F: 'exhaust', 0x4402: 'oil', 0x4300: 'coolant', 0x59D4: 'charge',
    0x554C: 'knock', 0x4A49: 'ign1', 0x4A4A: 'ign2', 0x4A4C: 'ign3', 0x4A4D: 'ign4', 0x4A4E: 'ign5', 0x4A4F: 'ign6',
    0x5425: 'battSoc'
};

var isNum = function (v) { return typeof v === 'number' && isFinite(v); };
var MAXK = ['rpm', 'power', 'torque', 'boost', 'oilPress', 'oil', 'coolant', 'gearbox', 'intake', 'charge', 'exhaust', 'knock'];

mgu.run({
    start: function (ctx) {
        var log = ctx.log, ui = ctx.ui, settings = ctx.settings;

        if (ctx.dataDir) { try { process.env.KM_DATA_DIR = ctx.dataDir; } catch (e) { } }

        var cfg = Limits.defaults();
        var m = {}, mAt = {};
        var cds = { oil: null, coolant: null, rpm: null };
        var peak = {}, trip = {}, startedAt = 0, running = false;
        var bars = { rpm: null, boost: null };
        var lastFrame = 0, lastV = null;
        var page = 'main';
        var extra = {};
        var records = new Records();
        var rec = null, recStart = 0, faultsBusy = false;

        var car = new Car(ctx, ['rpm', 'temps'], { demo: false });
        var link = new Diag(ctx.signals, log);
        link.quiet = true; link.busyLog = false;
        var diagReady = false;
        link.init().then(function () { diagReady = true; }).catch(function (e) { log.warn('diag init: ' + e); });

        var acc22 = function (u) { return u[0] === 0x62 || (u[0] === 0x7F && u[1] === 0x22); };
        var acc01 = function (u) { return (u[0] === 0x41 && u[1] === 0x42) || (u[0] === 0x7F && u[1] === 0x01); };

        function keep(key, v) {
            var now = Date.now();
            if (isNum(v)) { m[key] = v; mAt[key] = now; }
            else if (mAt[key] && now - mAt[key] > HOLD_MS) { m[key] = null; }
        }
        function readGroup(ecu, ids) {
            var data = [];
            for (var i = 0; i < ids.length; i++) { data.push(ids[i] >> 8, ids[i] & 0xFF); }
            return link.physical(ecu, 0x22, data, 700, acc22).then(function (uds) {
                var dids = [];
                for (var j = 0; j < ids.length; j++) { var d = decode.didById(ids[j]); if (d) dids.push(d); }
                var got = uds ? decode.didNumbers(dids, uds) : null;
                for (var k = 0; k < ids.length; k++) { keep(KEYOF[ids[k]], got ? got[ids[k]] : null); }
            }, function () { for (var k = 0; k < ids.length; k++) keep(KEYOF[ids[k]], null); });
        }
        function readEgs() {
            return link.physical(EGS, 0x22, [0x60, 0x00], 700, acc22).then(function (uds) {
                keep('gearbox', uds ? decode.didNumber(decode.didById(0x6000), uds) : null);
            }, function () { keep('gearbox', null); });
        }
        function readVoltage() {
            return link.physical(DME, 0x01, [0x42], 700, acc01).then(function (uds) {
                keep('voltage', uds ? decode.obdNumber(decode.pidById(0x42), uds) : null);
            }, function () { keep('voltage', null); });
        }

        var round = 0, sampling = false;
        function sampleOnce() {
            if (sampling || !diagReady || !link.p || faultsBusy) { return Promise.resolve(); }
            sampling = true; round++;
            var seq = readGroup(DME, FAST);
            if (round % 2 === 0) { seq = seq.then(function () { return readGroup(DME, KNOCK); }); }
            if (round % 6 === 0) {
                seq = seq.then(function () { return readGroup(DME, SLOW); })
                    .then(function () { return readGroup(DME, BATTERY); })
                    .then(readEgs).then(readVoltage);
            }
            return seq.then(function () { sampling = false; }, function () { sampling = false; });
        }
        setInterval(function () { sampleOnce(); }, CYCLE_MS);

        car.onSample(function () {
            var d = car.data();
            if (d) { cds.rpm = d.rpm; cds.oil = d.oil; cds.coolant = d.coolant; }
        });

        var PS_PER_KW = 1.35962;
        function airPowerPs(air, load) {
            if (!isNum(air) || air <= 0 || !isNum(load)) return null;
            var share = Math.max(0, Math.min(1, (load - 10) / 60));
            return air * (11.94 / 14.7) * 0.315 * share * PS_PER_KW;
        }
        function rpmNow() {
            var now = Date.now();
            if (isNum(m.rpm) && now - (mAt.rpm || 0) < 400) { return m.rpm < 200 ? 0 : m.rpm; }
            if (isNum(cds.rpm)) { return cds.rpm; }
            return isNum(m.rpm) ? m.rpm : null;
        }
        function peakOf(key, val) {
            if (isNum(val) && Date.now() - startedAt > PEAK_AFTER_MS) { peak[key] = Math.max(isNum(peak[key]) ? peak[key] : val, val); }
            return isNum(peak[key]) ? peak[key] : null;
        }
        function pick(a, b) { return isNum(a) ? a : (isNum(b) ? b : null); }

        function buildV() {
            var v = {};
            var ambient = isNum(m.ambient) ? m.ambient / 1000 : null;
            var above = function (abs) { return (isNum(abs) && isNum(ambient)) ? abs - ambient : null; };
            v.rpm = rpmNow();
            v.oil = pick(m.oil, cds.oil);
            v.coolant = pick(m.coolant, cds.coolant);
            v.intake = isNum(m.intake) ? m.intake : null;
            v.charge = isNum(m.charge) ? m.charge : null;
            v.boost = above(m.boostAbs);
            v.boostTarget = above(m.boostTargetAbs);
            v.oilPress = above(m.oilPressAbs);
            v.gearbox = isNum(m.gearbox) ? m.gearbox : null;
            v.exhaust = isNum(m.exhaust) ? m.exhaust : null;
            v.voltage = isNum(m.voltage) ? m.voltage : null;
            v.battSoc = (isNum(m.battSoc) && m.battSoc >= 0 && m.battSoc <= 100) ? m.battSoc : null;
            v.battVoltage = null; v.battCurrent = null;
            v.knock = isNum(m.knock) ? m.knock : null;
            v.load = isNum(m.load) ? m.load : null;
            v.airMass = isNum(m.airMass) ? m.airMass : null;

            var ang = [m.ign1, m.ign2, m.ign3, m.ign4, m.ign5, m.ign6];
            v.knockCyl = null;
            if (isNum(v.rpm) && v.rpm > 600 && ang.every(isNum)) {
                var top = Math.max.apply(null, ang), lo = Math.min.apply(null, ang);
                if (top - lo > 0.4) { v.knockCyl = ang.indexOf(lo) + 1; }
            }

            var rpm = isNum(v.rpm) ? Math.max(0, v.rpm) : null;
            var dmeTq = isNum(m.torque) ? Math.max(0, m.torque) : null;
            var dmePw = (dmeTq !== null && rpm !== null) ? dmeTq * rpm / 9549 * PS_PER_KW : null;
            var airPw = airPowerPs(m.airMass, m.load);
            if (airPw !== null && (dmePw === null || airPw > dmePw) && rpm !== null && rpm > 500) {
                v.power = airPw; v.torque = airPw / PS_PER_KW * 9549 / rpm;
            } else { v.power = dmePw; v.torque = dmeTq; }

            if (isNum(rpm)) {
                var run = rpm >= RPM_RUN;
                if (run && running === false) { startedAt = Date.now(); peak = {}; trip = {}; }
                running = run;
            }
            v.rpmPeak = peakOf('rpm', v.rpm); v.torquePeak = peakOf('torque', v.torque);
            v.powerPeak = peakOf('power', v.power); v.boostPeak = peakOf('boost', v.boost);
            v.oilPressPeak = peakOf('oilPress', v.oilPress);

            // Spitzen fuer Maximalwerte (diese Fahrt) + Rekorde (ueber alle Fahrten)
            if (Date.now() - startedAt > PEAK_AFTER_MS) {
                for (var mi = 0; mi < MAXK.length; mi++) {
                    var mk = MAXK[mi], mv = v[mk];
                    if (isNum(mv) && (!isNum(trip[mk]) || mv > trip[mk])) { trip[mk] = mv; records.offer(mk, mv, clock.wall()); }
                }
            }

            var allNull = FAST.every(function (id) { return !isNum(m[KEYOF[id]]); });
            if (diagReady && link.p && round > 2 && allNull) { v.status = 'Keine Antwort der DME - Zuendung an?'; v.statusErr = false; }
            else { v.status = ''; v.statusErr = false; }
            return v;
        }

        function glide(v) {
            var now = Date.now(), dt = Math.min(100, now - (lastFrame || now)); lastFrame = now;
            var k = 1 - Math.exp(-dt / GLIDE_MS);
            ['rpm', 'boost'].forEach(function (key) {
                var to = v[key], from = bars[key], snap = key === 'rpm' ? 5 : 0.005;
                if (!isNum(to)) { bars[key] = null; }
                else if (!isNum(from) || Math.abs(to - from) < snap) { bars[key] = to; }
                else { bars[key] = from + (to - from) * k; }
            });
            v.rpmBar = bars.rpm; v.boostBar = bars.boost;
        }

        // ---- Fehlerspeicher lesen (nur lesend, 19 02 an alle Steuergeraete) ----
        function readFaults() {
            if (faultsBusy || !diagReady || !link.p) return;
            faultsBusy = true;
            var addrs = faults.addresses();
            var scan = addrs.map(function (a) { return { addr: a, name: faults.unitName(a), state: 'wait', entries: [] }; });
            extra.faults = { reading: true, scan: scan, progress: 0 };
            var replied = {};
            link.functional(0x19, [0x02, 0x0D], { maxMs: 7000, onReply: function () { extra.faults.progress = (extra.faults.progress || 0) + 1; } })
                .then(function (map) {
                    var reps = new Map();
                    if (map && map.forEach) { map.forEach(function (uds, ecu) { reps.set(ecu, uds); replied[ecu] = 1; }); }
                    var parsed = faults.parse(reps) || { entries: [] };
                    var entries = parsed.entries || [];
                    for (var i = 0; i < scan.length; i++) {
                        var u = scan[i];
                        u.entries = entries.filter(function (e) { return e.ecu === u.addr; });
                        u.state = replied[u.addr] ? (u.entries.length ? 'faults' : 'ok') : 'none';
                    }
                    extra.faults = { scan: scan, units: addrs.length, entries: entries, at: new Date() };
                    faultsBusy = false;
                }, function (e) {
                    extra.faults = { scan: scan, units: addrs.length, entries: [], at: new Date(), error: String(e && e.message || e) };
                    faultsBusy = false;
                });
        }

        function showLogs() { try { extra.logs = logbook.list().map(function (l) { return logbook.summary(l.name); }).filter(Boolean); } catch (e) { extra.logs = []; } }
        function openLog(i) {
            var l = extra.logs && extra.logs[i];
            if (!l) return;
            try { extra.log = logbook.load(l.name); extra.channel = 'rpm'; page = 'log'; } catch (e) { log.warn('log load: ' + e); }
        }
        function toggleRecord() {
            if (rec) { try { rec.stop(); } catch (e) { } rec = null; extra.recording = null; showLogs(); }
            else { rec = new logbook.Recording(clock.wall()); recStart = Date.now(); }
        }
        setInterval(function () {
            if (rec) { try { rec.sample(lastV || {}, Date.now()); } catch (e) { } extra.recording = { ms: Date.now() - recStart }; }
        }, 100);

        function onEnter(p) {
            if (p === 'faults') { if (!extra.faults || (!extra.faults.reading && !extra.faults.scan)) readFaults(); }
            else if (p === 'logs') { showLogs(); }
            else if (p === 'records') { extra.maxima = { trip: trip, rec: records.best }; }
        }

        // ---- Render: dash.js (2880x764) in die 1600x520-Zelle einpassen ----
        var dstW = 1600, dstH = 520;
        var fitW = dstW, fitH = Math.round(dstW * SH / SW), fitY = Math.round((dstH - fitH) / 2);
        var bg = dash.C.asphalt;
        var pressedId = null;

        ctx.loop('MAIN', 4, function () {
            var v = buildV(); glide(v); lastV = v;
            if (page === 'records') { extra.maxima = { trip: trip, rec: records.best }; }
            var src = new KitCanvas(SW, SH);
            try { dash.draw(src, page, v, cfg, { focus: null, pressed: pressedId }, extra); }
            catch (e) { log.warn('draw ' + page + ': ' + e); }
            var out = new KitCanvas(dstW, dstH); out.clear(bg);
            if (out.drawImage) { out.drawImage(src.d, SW, SH, 0, fitY, fitW, fitH); }
            else { blitScaled(out, src, fitY, fitW, fitH); }
            return ui.image('MAIN_GFX', out);
        });

        function blitScaled(dst, src, y0, w, h) {
            var d = dst.d, s = src.d, fx = src.w / w, fy = src.h / h;
            for (var py = 0; py < h; py++) {
                var sy = Math.min(src.h - 1, (py * fy) | 0) * src.w;
                var di = ((py + y0) * dst.w) * 4;
                for (var px = 0; px < w; px++, di += 4) {
                    var si = (sy + Math.min(src.w - 1, (px * fx) | 0)) * 4;
                    d[di] = s[si]; d[di + 1] = s[si + 1]; d[di + 2] = s[si + 2]; d[di + 3] = 255;
                }
            }
        }

        // ---- Eingabe: Tippen -> dash-Koordinaten -> Ziel -> Aktion ----
        var WRITE = { cooling: 1, 'cooling!': 1, 'faults:clear': 1, 'faults:clear!': 1 };
        function act(id) {
            if (WRITE[id]) { log.info('Schreib-Aktion auf ID7 aus: ' + id); return; }
            if (id.indexOf('tab:') === 0) { page = id.slice(4); onEnter(page); return; }
            if (id.indexOf('menu:') === 0) { page = id.slice(5); return; }
            if (id === 'settings:back') { page = 'settings'; return; }
            if (id === 'reset') { peak = {}; trip = {}; return; }
            if (id === 'record') { toggleRecord(); return; }
            if (id === 'faults:read') { readFaults(); return; }
            if (id.indexOf('unit:') === 0) { extra.unit = parseInt(id.slice(5), 10); page = 'faultunit'; return; }
            if (id === 'faults:back') { page = 'faults'; return; }
            if (id === 'records:clear' || id === 'records:clear!') { records.clear(); return; }
            if (id.indexOf('open:') === 0) { openLog(parseInt(id.slice(5), 10)); return; }
            if (id.indexOf('chan:') === 0) { extra.channel = id.slice(5); return; }
            if (id === 'delete' || id === 'delete!') { if (extra.log) { try { logbook.remove(extra.log.name); } catch (e) { } } page = 'logs'; showLogs(); return; }
            if (id === 'deleteAll' || id === 'deleteAll!') { try { logbook.removeAll(); } catch (e) { } showLogs(); return; }
            if (id === 'back') { page = (page === 'faultunit') ? 'faults' : 'logs'; return; }
            if (id === 'usb') { extra.usb = { text: 'USB-Export auf iDrive 7 nicht verfuegbar.' }; return; }
            if (id.indexOf('dec:') === 0) { cfg = Limits.stepped(cfg, id.slice(4), -1); return; }
            if (id.indexOf('inc:') === 0) { cfg = Limits.stepped(cfg, id.slice(4), 1); return; }
            if (id.indexOf('toggle:') === 0) { cfg = Limits.toggled(cfg, id.slice(7)); return; }
            if (id === 'defaults') { cfg = Limits.reset(cfg, page === 'ready' ? 'ready' : 'limits'); return; }
        }
        if (ctx.onTap) {
            ctx.onTap(function (x, y) {
                var dx = x * SW / fitW, dy = (y - fitY) * SH / fitH;
                if (dy < 0 || dy > SH) return;
                var tg = dash.targets(page, extra) || [];
                for (var i = 0; i < tg.length; i++) {
                    var t = tg[i];
                    if (dx >= t.x && dx < t.x + t.w && dy >= t.y && dy < t.y + t.h) { act(t.id); return; }
                }
            });
        }
        ctx.onBack && ctx.onBack(function () { if (page !== 'main') { page = 'main'; return true; } });

        log.info('Motordaten (ID7) gestartet');
    }
});
