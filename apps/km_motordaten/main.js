'use strict';
/**
 * Motordaten fuer BMW iDrive 7 (MGU), auch ID8 - dieselbe App wie die M2-Version
 * (Prototype019/motordaten, iDrive 8), nur auf dem MGU App Kit (kit/, MIT).
 *
 * Das Design ist 1:1 die ID8-App: dash.js zeichnet die Seiten (2880x764), wir
 * passen sie in den ID7-Bildbereich (1600x520) ein und uebergeben das Bild.
 * Werte liest es per UDS-Diagnose (0x22) aus der DME (0x12), dem Getriebe
 * (EGS 0x18) und einer OBD-PID - ueber kit/diag.js, dekodiert mit decode.js
 * (DME8FF_R, B58/S58). Fehlerspeicher lesen: 19 02 an alle Steuergeraete.
 *
 * Zwei Schreib-Aktionen wie in der M2-App, mit denselben Schutzregeln:
 *  - MHD Max Cooling (2F 03 01/00 nur an die DME): die App erkennt selbst, ob die
 *    DME mit MHD laeuft (einmalige Abfrage "Max Cooling aus", Echo 6F 03 00), und
 *    zeigt den Knopf nur dann. An nur bei laufendem Motor (> 500 U/min).
 *  - Fehlerspeicher loeschen (14 FF FF FF): nur Zuendung an + Motor aus, mit
 *    Bestaetigung, Steuergeraet fuer Steuergeraet, nie die Headunit (0x63).
 *
 * iDrive-7-Laufzeit = Node 8: kein ?./??/Spread/import/Klassenfelder.
 */
var fs = require('fs');
var path = require('path');
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

        var dataDir = process.env.KM_DATA_DIR || '';
        var cfg = Limits.load();                      // Grenzwerte, gespeichert in data/limits.json
        function saveCfg() { try { Limits.save(cfg); } catch (e) { log.warn('limits save: ' + e); } }

        // MHD: einmal erkannt -> in data/mhd.json gemerkt (dann keine erneute Abfrage)
        var MHD_FILE = dataDir ? path.join(dataDir, 'mhd.json') : null;
        var mhd = null;                               // true = MHD erkannt, false = DME kennt die Routine nicht, null = offen
        try { if (MHD_FILE && JSON.parse(fs.readFileSync(MHD_FILE, 'utf8')).mhd === true) mhd = true; } catch (e) { }
        function saveMhd() { try { if (MHD_FILE) fs.writeFileSync(MHD_FILE, JSON.stringify({ mhd: true, at: Date.now() })); } catch (e) { } }
        var cooling = { state: null }, coolingTimer = null;
        var probeAt = 0, probeTries = 0;
        var recordsConfirm = false;

        // Alle Diagnose-Anfragen nacheinander (Polling, Fehler lesen, Schreibbefehle)
        var chain = Promise.resolve();
        function serial(fn) { var p = chain.then(fn, fn); chain = p.then(function () { }, function () { }); return p; }

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
            return serial(function () {
                var seq = readGroup(DME, FAST);
                if (round % 2 === 0) { seq = seq.then(function () { return readGroup(DME, KNOCK); }); }
                if (round % 6 === 0) {
                    seq = seq.then(function () { return readGroup(DME, SLOW); })
                        .then(function () { return readGroup(DME, BATTERY); })
                        .then(readEgs).then(readVoltage);
                }
                return seq;
            }).then(function () { sampling = false; probeMhd(); }, function () { sampling = false; });
        }
        setInterval(function () { sampleOnce(); }, CYCLE_MS);

        // ---- MHD erkennen: die DME einmal harmlos fragen (Max Cooling AUS = 2F 03 00) ----
        // Echo 6F 03 00 -> die DME laeuft mit MHD-Code. NRC "Dienst/ID unbekannt" -> kein MHD.
        // Keine oder andere Antwort -> spaeter nochmal (hoechstens 5 Versuche, alle 20 s).
        var accCool = function (u) { return (u[0] === 0x6F && u[1] === 0x03) || (u[0] === 0x7F && u[1] === 0x2F); };
        var probing = false;
        function probeMhd() {
            if (mhd !== null || probing || probeTries >= 5 || !isNum(m.rpm) || Date.now() - probeAt < 20000) return;
            probing = true; probeAt = Date.now(); probeTries++;
            serial(function () { return link.physical(DME, 0x2F, [0x03, 0x00], 2500, accCool); }).then(function (u) {
                probing = false;
                if (u && u[0] === 0x6F && u[1] === 0x03 && u[2] === 0x00) {
                    mhd = true; saveMhd(); cooling.state = 'OFF';
                    if (!cfg.mhdCoolingOn) { cfg.mhdCoolingOn = 1; saveCfg(); }   // beim ersten Erkennen einschalten
                    log.info('MHD erkannt: Max Cooling verfuegbar');
                } else if (u && u[0] === 0x7F && (u[2] === 0x11 || u[2] === 0x12 || u[2] === 0x31)) {
                    mhd = false; log.info('kein MHD (DME: ' + u[2].toString(16) + ')');
                }
            }, function () { probing = false; });
        }

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
            if (diagReady && link.p && round > 2 && allNull) { v.status = 'Keine Antwort der DME – Zündung an?'; v.statusErr = false; }
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
        function readFaults(note) {
            if (faultsBusy || !diagReady || !link.p) return;
            faultsBusy = true;
            var addrs = faults.addresses();
            var scan = addrs.map(function (a) { return { addr: a, name: faults.unitName(a), state: 'wait', entries: [] }; });
            extra.faults = { reading: true, scan: scan, progress: 0 };
            var replied = {};
            serial(function () { return link.functional(0x19, [0x02, 0x0D], { maxMs: 7000, onReply: function () { extra.faults.progress = (extra.faults.progress || 0) + 1; } }); })
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
                    extra.faults = { scan: scan, units: addrs.length, entries: entries, at: new Date(), note: note || null };
                    faultsBusy = false;
                }, function (e) {
                    extra.faults = { scan: scan, units: addrs.length, entries: [], at: new Date(), error: String(e && e.message || e) };
                    faultsBusy = false;
                });
        }

        // ---- MHD Max Cooling (wie die M2-App): an nur bei laufendem Motor, aus jederzeit ----
        var COOLING_MIN_RPM = 500;
        function coolingNote(note) {
            clearTimeout(coolingTimer);
            cooling = Object.assign({}, cooling, { note: note, confirm: false });
            coolingTimer = setTimeout(function () { cooling = Object.assign({}, cooling, { note: null }); }, 3000);
        }
        function sendCooling(on) {
            if (mhd !== true || !cfg.mhdCoolingOn || cooling.busy) return;
            var rpm = lastV && lastV.rpm;
            if (on && !(isNum(rpm) && rpm > COOLING_MIN_RPM)) { coolingNote('Erst Motor starten'); return; }
            clearTimeout(coolingTimer);
            cooling = Object.assign({}, cooling, { busy: true, confirm: false, note: null });
            var want = on ? 0x01 : 0x00;
            serial(function () { return link.physical(DME, 0x2F, [0x03, want], 2500, accCool); }).then(function (u) {
                var echoed = !!(u && u[0] === 0x6F && u[1] === 0x03 && u[2] === want);
                cooling = { state: echoed ? (on ? 'ON' : 'OFF') : cooling.state, busy: false };
                log.info('MHD Max Cooling ' + (on ? 'an' : 'aus') + ': ' + (echoed ? 'bestaetigt' : 'keine Bestaetigung'));
                if (!echoed) coolingNote('Kein MHD-Echo');
            }, function (e) {
                cooling = Object.assign({}, cooling, { busy: false });
                coolingNote('Nicht gesendet');
                log.warn('max cooling: ' + (e && e.message));
            });
        }
        function coolingPressed() {
            if (mhd !== true || !cfg.mhdCoolingOn || cooling.busy) return;
            sendCooling(cooling.state !== 'ON');
        }

        // ---- Fehlerspeicher loeschen (wie die M2-App): nur Zuendung an + Motor aus, mit Bestaetigung,
        // Steuergeraet fuer Steuergeraet (14 FF FF FF), nie die Headunit (0x63). Danach neu lesen. ----
        var NO_CLEAR = [0x63];
        var acc14 = function (u) { return u[0] === 0x54 || (u[0] === 0x7F && u[1] === 0x14); };
        function clearBlocked() {
            var fresh = Date.now() - (mAt.rpm || 0) < 3000;
            var rpm = fresh ? m.rpm : cds.rpm;
            if (!isNum(rpm)) return 'Löschen nur bei Zündung an: keine Drehzahl vom Motor.';
            if (rpm >= 200) return 'Löschen nur bei Motor aus. Motor abstellen, Zündung an lassen.';
            return null;
        }
        function clearFaults() {
            var f = extra.faults || {};
            var why = clearBlocked();
            if (why) { extra.faults = Object.assign({}, f, { note: why, warn: true, confirmClear: false }); return; }
            var units = [];
            (f.entries || []).forEach(function (e) { if (units.indexOf(e.ecu) < 0) units.push(e.ecu); });
            var skipped = units.filter(function (u) { return NO_CLEAR.indexOf(u) >= 0; });
            var todo = units.filter(function (u) { return NO_CLEAR.indexOf(u) < 0; });
            extra.faults = Object.assign({}, f, { clearing: true, confirmClear: false, note: null, warn: false });
            var cleared = 0, failed = 0;
            todo.reduce(function (p, u) {
                return p.then(function () {
                    return serial(function () { return link.physical(u, 0x14, [0xFF, 0xFF, 0xFF], 8000, acc14); })
                        .then(function (r) { if (r && r[0] === 0x54) cleared++; else failed++; }, function () { failed++; });
                });
            }, Promise.resolve()).then(function () {
                var parts = ['Gelöscht in ' + cleared + ' ' + (cleared === 1 ? 'Steuergerät' : 'Steuergeräten')];
                if (failed) parts.push(failed + ' ohne Bestätigung');
                if (skipped.length) parts.push('Headunit ausgelassen');
                log.info('Fehler geloescht: ' + cleared + ', ohne Bestaetigung: ' + failed);
                extra.faults = { reading: false };
                readFaults(parts.join(', ') + '.');
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
            else if (p === 'records') { extra.maxima = { trip: trip, rec: records.best, confirm: recordsConfirm }; }
        }

        // ---- Render: dash.js (2880x764) in die 1600x520-Zelle einpassen ----
        var dstW = 1600, dstH = 520;
        var fitW = dstW, fitH = Math.round(dstW * SH / SW), fitY = Math.round((dstH - fitH) / 2);
        var bg = dash.C.asphalt;
        var pressedId = null;

        ctx.loop('MAIN', 4, function () {
            var v = buildV(); glide(v); lastV = v;
            // Max-Cooling-Knopf nur, wenn MHD erkannt ist und die Option an ist
            extra.cooling = (mhd === true && cfg.mhdCoolingOn) ? Object.assign({}, cooling) : null;
            if (page === 'records') { extra.maxima = { trip: trip, rec: records.best, confirm: recordsConfirm }; }
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
        function act(id) {
            if (id.indexOf('tab:') === 0) {
                // ein Seitenwechsel nimmt offene Bestaetigungen zurueck (wie die M2-App)
                recordsConfirm = false; extra.confirmDelete = false; extra.confirmDeleteAll = false; extra.usb = null;
                if (extra.faults && extra.faults.confirmClear) extra.faults = Object.assign({}, extra.faults, { confirmClear: false });
                page = id.slice(4); onEnter(page); return;
            }
            if (id.indexOf('menu:') === 0) { page = id.slice(5); return; }
            if (id === 'settings:back') { page = 'settings'; return; }
            if (id === 'reset') { peak = {}; trip = {}; return; }
            if (id === 'record') { toggleRecord(); return; }
            // MHD Max Cooling
            if (id === 'cooling' || id === 'cooling!') { coolingPressed(); return; }
            // Fehlerspeicher
            if (id === 'faults:read') { readFaults(); return; }
            if (id === 'faults:clear') {
                var why = clearBlocked(), f = extra.faults || {};
                extra.faults = why ? Object.assign({}, f, { note: why, warn: true, confirmClear: false })
                    : Object.assign({}, f, { confirmClear: true, note: null, warn: false });
                return;
            }
            if (id === 'faults:clear!') { clearFaults(); return; }
            if (id.indexOf('unit:') === 0) { extra.unit = parseInt(id.slice(5), 10); page = 'faultunit'; return; }
            if (id === 'faults:back') { page = 'faults'; return; }
            // Rekorde (mit Bestaetigung)
            if (id === 'records:clear') { recordsConfirm = true; return; }
            if (id === 'records:clear!') { records.clear(); recordsConfirm = false; return; }
            // Logs (Loeschen mit Bestaetigung)
            if (id.indexOf('open:') === 0) { openLog(parseInt(id.slice(5), 10)); extra.confirmDelete = false; return; }
            if (id.indexOf('chan:') === 0) { extra.channel = id.slice(5); return; }
            if (id === 'delete') { extra.confirmDelete = true; return; }
            if (id === 'delete!') { if (extra.log) { try { logbook.remove(extra.log.name); } catch (e) { } } extra.confirmDelete = false; page = 'logs'; showLogs(); return; }
            if (id === 'deleteAll') { extra.confirmDeleteAll = true; return; }
            if (id === 'deleteAll!') { try { logbook.removeAll(); } catch (e) { } extra.confirmDeleteAll = false; showLogs(); return; }
            if (id === 'back') { page = (page === 'faultunit') ? 'faults' : 'logs'; return; }
            if (id === 'usb') { extra.usb = { text: 'USB-Export auf iDrive 7 nicht verfügbar.' }; return; }
            // Grenzwerte / Einstellungen (gespeichert)
            if (id.indexOf('dec:') === 0) { cfg = Limits.stepped(cfg, id.slice(4), -1); saveCfg(); return; }
            if (id.indexOf('inc:') === 0) { cfg = Limits.stepped(cfg, id.slice(4), 1); saveCfg(); return; }
            if (id.indexOf('toggle:') === 0) { cfg = Limits.toggled(cfg, id.slice(7)); saveCfg(); return; }
            if (id === 'defaults') { cfg = Limits.reset(cfg, page === 'ready' ? 'ready' : 'limits'); saveCfg(); return; }
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
