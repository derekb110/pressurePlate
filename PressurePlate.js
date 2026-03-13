/* ============================================================
   PressurePlateDoors (ES5) — Teleport-Style UI + Ping + Locks + Messages
   ============================================================
   FEATURES
   - Plates trigger doors when ANY token is FULLY on the plate token bbox.
   - Supports:
     (A) Single Plate -> N Doors
     (B) Group (K-of-N plates) -> N Doors
   - Door modes:
     lock   => open/unlock when active; close/lock when inactive
     secret => reveal/open when active; hide/close/lock when inactive
   - UI (GM-only): Teleport-ish list cards with icon buttons
   - Ping plate
   - Trigger lock (mechanism lock):
       - locked + lockFreeze=false => forces doors to inactive state and ignores triggers
       - locked + lockFreeze=true  => freezes door state (no updates)
   - Config lock:
       - blocks edits; UI shows disabled buttons
       - GM Override grants 60s edit access
   - Auto-lock after first trigger:
       - when group first becomes active, apply active state, then lock+freeze
   - Trigger + Release messages (optional):
       - Plate: msgOn / msgOff (edge-triggered)
       - Group: msgOn / msgOff (edge-triggered)

   IMPORTANT
   - KEEP THE SAME STATE KEY FOREVER or bindings "disappear" (they won't be deleted; they'd be under the old key).
   ============================================================ */

var PressurePlateDoors = PressurePlateDoors || (function () {
    "use strict";

    var MOD = "PressurePlateDoors";

    // >>> KEEP THIS THE SAME FOREVER (use your existing key) <<<
    // If your current working script uses a different key, replace this string with THAT key once.
    var STATE = "PPD_CAMPAIGN_CORE";

    var DEBOUNCE_MS = 120;
    var OVERRIDE_MS = 60000; // 60s config override
    var TRAP_TYPES = { none: true, alarm: true, damage: true, teleport: true, reveal: true };
    var TRAP_TRIGGERS = { press: true, release: true, both: true };

    function defaultTrapConfig() {
        return {
            enabled: false,
            type: "none",
            trigger: "press",
            message: "",
            damage: "1d6",
            teleport: {
                pageId: "",
                left: 0,
                top: 0,
                name: ""
            },
            revealTargets: []
        };
    }

    function backfillTrapConfig(trap) {
        trap = trap || {};

        if (typeof trap.enabled === "undefined") trap.enabled = false;
        if (!TRAP_TYPES[trap.type]) trap.type = "none";
        if (!TRAP_TRIGGERS[trap.trigger]) trap.trigger = "press";
        if (typeof trap.message === "undefined") trap.message = "";
        if (typeof trap.damage === "undefined") trap.damage = "1d6";

        trap.teleport = trap.teleport || {};
        if (typeof trap.teleport.pageId === "undefined") trap.teleport.pageId = "";
        if (typeof trap.teleport.left === "undefined") trap.teleport.left = 0;
        if (typeof trap.teleport.top === "undefined") trap.teleport.top = 0;
        if (typeof trap.teleport.name === "undefined") trap.teleport.name = "";

        if (!trap.revealTargets) trap.revealTargets = [];

        return trap;
    }

    function newPlateData() {
        return {
            doors: {},
            msgOn: "",
            msgOff: "",
            lastActive: false,
            trap: defaultTrapConfig()
        };
    }

    /* ---------- state ---------- */
    function ensureState() {
        state[STATE] = state[STATE] || {
            plates: {},        // plateId -> { doors: { doorId: 'lock'|'secret' }, msgOn, msgOff, lastActive }
            groups: {},        // groupName -> { required, plates[], doors{}, locked, lockFreeze, cfgLocked, autoLock, hasTriggered, msgOn, msgOff, lastActive }
            uiPageId: null,
            last: 0,
            editOverride: {}   // groupName -> expiry timestamp
        };

        var st = state[STATE];

        // backfill plates
        for (var pid in st.plates) {
            if (!st.plates.hasOwnProperty(pid)) continue;
            var p = st.plates[pid];
            if (!p) continue;
            if (!p.doors) p.doors = {};
            if (typeof p.msgOn === "undefined") p.msgOn = "";
            if (typeof p.msgOff === "undefined") p.msgOff = "";
            if (typeof p.lastActive === "undefined") p.lastActive = false;
            p.trap = backfillTrapConfig(p.trap);
        }

        // backfill groups
        for (var gname in st.groups) {
            if (!st.groups.hasOwnProperty(gname)) continue;
            var g = st.groups[gname];
            if (!g) continue;

            if (!g.doors) g.doors = {};
            if (!g.plates) g.plates = [];
            if (typeof g.required === "undefined") g.required = 0;

            // trigger lock
            if (typeof g.locked === "undefined") g.locked = false;
            if (typeof g.lockFreeze === "undefined") g.lockFreeze = false;

            // config lock
            if (typeof g.cfgLocked === "undefined") g.cfgLocked = false;

            // auto-lock
            if (typeof g.autoLock === "undefined") g.autoLock = false;
            if (typeof g.hasTriggered === "undefined") g.hasTriggered = false;

            // messages
            if (typeof g.msgOn === "undefined") g.msgOn = "";
            if (typeof g.msgOff === "undefined") g.msgOff = "";
            if (typeof g.lastActive === "undefined") g.lastActive = false;
        }

        if (!st.editOverride) st.editOverride = {};

        return st;
    }

    function ensurePlateData(plateId) {
        var st = ensureState();
        st.plates[plateId] = st.plates[plateId] || newPlateData();

        var p = st.plates[plateId];
        if (!p.doors) p.doors = {};
        if (typeof p.msgOn === "undefined") p.msgOn = "";
        if (typeof p.msgOff === "undefined") p.msgOff = "";
        if (typeof p.lastActive === "undefined") p.lastActive = false;
        p.trap = backfillTrapConfig(p.trap);

        return p;
    }

    /* ---------- utils ---------- */
    function esc(s) {
        s = String(s || "");
        return s.replace(/[&<>"']/g, function (c) {
            return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
        });
    }

    function whisper(html) { sendChat("", "/w gm " + html); }
    function shortId(id) { return (id || "").slice(-6); }

    function safeGroupNameFromPage(pageName) {
        var s = String(pageName || "Map");
        s = s.replace(/[^A-Za-z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
        if (!s) s = "Map";
        return s + "_Group";
    }

    function postTriggerMessage(raw) {
        raw = String(raw || "").trim();
        if (!raw) return;
        // Public narration. If you want GM-only, switch to: "/w gm "
        sendChat("", "/desc " + raw);
    }

    /* ---------- ping ---------- */
    function pingGraphic(g, playerid) {
        if (!g) return;
        sendPing(g.get("left"), g.get("top"), g.get("_pageid"), playerid, true);

        // aura flash GM-only
        var prev = {
            aura1_radius: g.get("aura1_radius"),
            aura1_color: g.get("aura1_color"),
            showplayers_aura1: g.get("showplayers_aura1")
        };

        g.set({ aura1_radius: 1, aura1_color: "#ff00ff", showplayers_aura1: false });

        setTimeout(function () {
            var gg = getObj("graphic", g.id);
            if (!gg) return;
            gg.set(prev);
        }, 1200);
    }

    function cmdPingPlate(playerid, plateId) {
        var p = getObj("graphic", plateId);
        if (!p) return whisper("Plate not found.");
        pingGraphic(p, playerid);
    }

    /* ---------- geometry ---------- */
    function rect(g) {
        var x = g.get("left"), y = g.get("top"), w = g.get("width"), h = g.get("height");
        return { left: x - w / 2, right: x + w / 2, top: y - h / 2, bottom: y + h / 2 };
    }

    // token bbox must be FULLY inside plate bbox
    function fullyInside(pr, tr) {
        return (tr.left >= pr.left && tr.right <= pr.right && tr.top >= pr.top && tr.bottom <= pr.bottom);
    }

    function tokensOnObjectsLayer(pageId) {
        return findObjs({ _type: "graphic", _subtype: "token", layer: "objects", _pageid: pageId }) || [];
    }

    function isPlateOccupied(plateGraphic) {
        return plateOccupants(plateGraphic).length > 0;
    }

    function plateOccupants(plateGraphic) {
        var pr = rect(plateGraphic);
        var toks = tokensOnObjectsLayer(plateGraphic.get("_pageid"));
        var hits = [];
        for (var i = 0; i < toks.length; i++) {
            if (fullyInside(pr, rect(toks[i]))) hits.push(toks[i]);
        }
        return hits;
    }

    /* ---------- door ops ---------- */
    function applyOccupied(door, mode) {
        if (!door) return;
        if (mode === "lock") {
            door.set({ isLocked: false, isOpen: true });
        }
        if (mode === "secret") {
            door.set({ isSecret: false, isLocked: false, isOpen: true });
        }
    }

    function applyUnoccupied(door, mode) {
        if (!door) return;
        if (mode === "lock") {
            door.set({ isOpen: false, isLocked: true });
        }
        if (mode === "secret") {
            door.set({ isOpen: false, isSecret: true, isLocked: true });
        }
    }

    function trapFiresOnEdge(trigger, wasActive, isActive) {
        if (trigger === "press") return isActive && !wasActive;
        if (trigger === "release") return !isActive && wasActive;
        if (trigger === "both") return isActive !== wasActive;
        return false;
    }

    function trapTypeLabel(type) {
        if (type === "alarm") return "Alarm";
        if (type === "damage") return "Damage";
        if (type === "teleport") return "Teleport";
        if (type === "reveal") return "Reveal";
        return "None";
    }

    function trapTriggerLabel(trigger) {
        if (trigger === "press") return "Press";
        if (trigger === "release") return "Release";
        if (trigger === "both") return "Both";
        return "Press";
    }

    function joinTokenNames(tokens) {
        var names = [];
        for (var i = 0; i < tokens.length; i++) {
            names.push(tokens[i].get("name") || ("Token …" + shortId(tokens[i].id)));
        }
        return names.join(", ");
    }

    function runRevealTargets(refs) {
        var changed = 0;
        for (var i = 0; i < refs.length; i++) {
            var ref = String(refs[i] || "");
            var parts = ref.split(":");
            if (parts.length !== 2) continue;

            var type = parts[0];
            var id = parts[1];
            var obj = getObj(type, id);
            if (!obj) continue;

            if (type === "graphic") {
                if (obj.get("layer") === "gmlayer") {
                    obj.set({ layer: "objects" });
                    changed++;
                }
            } else if (type === "door") {
                if (obj.get("isSecret")) {
                    obj.set({ isSecret: false });
                    changed++;
                }
            }
        }
        return changed;
    }

    function runTeleport(tokens, dest) {
        if (!dest || !dest.pageId) return 0;

        var moved = 0;
        for (var i = 0; i < tokens.length; i++) {
            tokens[i].set({
                _pageid: dest.pageId,
                left: dest.left,
                top: dest.top,
                layer: "objects"
            });
            moved++;
        }
        return moved;
    }

    function firePlateTrap(plate, pdata, occupants) {
        if (!plate || !pdata) return;

        var trap = backfillTrapConfig(pdata.trap);
        if (!trap.enabled || trap.type === "none") return;

        var plateName = plate.get("name") || ("Plate …" + shortId(plate.id));
        var occupantNames = occupants.length ? joinTokenNames(occupants) : plateName;
        var customMsg = String(trap.message || "").trim();

        if (trap.type === "alarm") {
            postTriggerMessage(customMsg || ("Trap triggered at " + plateName + "."));
            return;
        }

        if (trap.type === "damage") {
            postTriggerMessage((customMsg || "Trap hits") + ": " + occupantNames + " take [[" + String(trap.damage || "1d6") + "]] damage.");
            return;
        }

        if (trap.type === "teleport") {
            if (!trap.teleport.pageId) return;
            if (!occupants.length) return;

            var moved = runTeleport(occupants, trap.teleport);
            if (moved && customMsg) postTriggerMessage(customMsg);
            return;
        }

        if (trap.type === "reveal") {
            var revealed = runRevealTargets(trap.revealTargets || []);
            if (revealed && customMsg) postTriggerMessage(customMsg);
            return;
        }
    }

    /* ---------- evaluation: single plate ---------- */
    function evaluatePlate(plateId) {
        var plate = getObj("graphic", plateId);
        if (!plate) return;

        var pdata = ensurePlateData(plateId);
        if (!pdata || !pdata.doors) return;

        var occupants = plateOccupants(plate);
        var wasActive = !!pdata.lastActive;
        var occ = isPlateOccupied(plate);

        // edge-triggered messages
        if (occ && !wasActive) postTriggerMessage(pdata.msgOn);
        if (!occ && wasActive) postTriggerMessage(pdata.msgOff);
        pdata.lastActive = occ;

        for (var doorId in pdata.doors) {
            if (!pdata.doors.hasOwnProperty(doorId)) continue;
            var mode = pdata.doors[doorId];
            var d = getObj("door", doorId);
            if (occ) applyOccupied(d, mode);
            else applyUnoccupied(d, mode);
        }

        if (trapFiresOnEdge(pdata.trap.trigger, wasActive, occ)) {
            firePlateTrap(plate, pdata, occupants);
        }
    }

    /* ---------- evaluation: groups ---------- */
    function pruneGroup(g) {
        // plates
        var cleanedPlates = [];
        for (var i = 0; i < g.plates.length; i++) {
            if (getObj("graphic", g.plates[i])) cleanedPlates.push(g.plates[i]);
        }
        g.plates = cleanedPlates;

        // doors
        var cleanedDoors = {};
        for (var did in g.doors) {
            if (!g.doors.hasOwnProperty(did)) continue;
            if (getObj("door", did)) cleanedDoors[did] = g.doors[did];
        }
        g.doors = cleanedDoors;
    }

    function groupPressedCount(group) {
        var count = 0;
        for (var i = 0; i < group.plates.length; i++) {
            var pid = group.plates[i];
            var plate = getObj("graphic", pid);
            if (!plate) continue;
            if (isPlateOccupied(plate)) count++;
        }
        return count;
    }

    function clampRequired(g) {
        var n = g.plates.length;
        var req = parseInt(g.required, 10);
        if (isNaN(req) || req < 0) req = 0; // 0 => ALL
        if (req === 0) return n;
        if (req > n) return n;
        return req;
    }

    function evaluateGroup(groupName) {
        var st = ensureState();
        var g = st.groups[groupName];
        if (!g) return;

        pruneGroup(g);

        // trigger-locked:
        // - if lockFreeze: do nothing (freeze state)
        // - else: force revert to inactive state
        if (g.locked) {
            g.lastActive = false; // so it can re-announce on next legit activation
            if (g.lockFreeze) return;

            for (var doorId in g.doors) {
                if (!g.doors.hasOwnProperty(doorId)) continue;
                applyUnoccupied(getObj("door", doorId), g.doors[doorId]);
            }
            return;
        }

        var pressed = groupPressedCount(g);
        var required = clampRequired(g);
        var active = (pressed >= required);

        // edge-triggered messages
        if (active && !g.lastActive) postTriggerMessage(g.msgOn);
        if (!active && g.lastActive) postTriggerMessage(g.msgOff);
        g.lastActive = active;

        // Auto-lock after first trigger: on first activation, apply active state,
        // then lock+freeze if autoLock is enabled.
        if (active && !g.hasTriggered) {
            g.hasTriggered = true;

            for (var didA in g.doors) {
                if (!g.doors.hasOwnProperty(didA)) continue;
                applyOccupied(getObj("door", didA), g.doors[didA]);
            }

            if (g.autoLock) {
                g.locked = true;
                g.lockFreeze = true;
            }
            return;
        }

        // normal behavior
        for (var did in g.doors) {
            if (!g.doors.hasOwnProperty(did)) continue;
            var mode = g.doors[did];
            var d = getObj("door", did);
            if (active) applyOccupied(d, mode);
            else applyUnoccupied(d, mode);
        }
    }

    function evaluateAll() {
        var st = ensureState();

        for (var plateId in st.plates) {
            if (!st.plates.hasOwnProperty(plateId)) continue;
            evaluatePlate(plateId);
        }
        for (var gname in st.groups) {
            if (!st.groups.hasOwnProperty(gname)) continue;
            evaluateGroup(gname);
        }
    }

    function debouncedCheck() {
        var st = ensureState();
        var now = Date.now();
        if (now - st.last < DEBOUNCE_MS) return;
        st.last = now;
        evaluateAll();
    }

    /* ---------- page handling ---------- */
    function getGMViewPageId(playerid) {
        var p = getObj("player", playerid);
        var last = p && p.get("lastpage");
        return last || Campaign().get("playerpageid");
    }

    function setUIPage(playerid) { ensureState().uiPageId = getGMViewPageId(playerid); }
    function getUIPage(playerid) {
        var st = ensureState();
        if (!st.uiPageId) st.uiPageId = getGMViewPageId(playerid);
        return st.uiPageId;
    }

    function getUIPageName(pageId) {
        var p = getObj("page", pageId);
        return (p && p.get("name")) ? p.get("name") : "Map";
    }

    /* ---------- config lock enforcement ---------- */
    function hasEditOverride(groupName) {
        var st = ensureState();
        var exp = st.editOverride[groupName];
        if (!exp) return false;
        if (Date.now() > exp) {
            delete st.editOverride[groupName];
            return false;
        }
        return true;
    }

    function requireConfigEditable(groupName) {
        var st = ensureState();
        var g = st.groups[groupName];
        if (!g) return true;
        if (!g.cfgLocked) return true;
        if (hasEditOverride(groupName)) return true;
        whisper("Group <b>" + esc(groupName) + "</b> is <b>CONFIG LOCKED</b>. Use <b>Override</b> to edit for 60s.");
        return false;
    }

    /* ---------- UI buttons ---------- */
    function iconBtn(icon, cmd, title) {
        return '<a title="' + esc(title || "") + '" style="' +
            'display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;' +
            'background:#f3f4f6;border:2px solid #111;border-radius:10px;' +
            'text-decoration:none;color:#111;font-size:18px;font-weight:900;' +
            'margin:0 10px 6px 0;" href="' + esc(cmd) + '">' + esc(icon) + '</a>';
    }

    function iconBtnDisabled(icon, title) {
        return '<span title="' + esc(title || "") + '" style="' +
            'display:inline-block;width:36px;height:36px;line-height:36px;text-align:center;' +
            'background:#e5e7eb;border:2px solid #9ca3af;border-radius:10px;' +
            'color:#6b7280;font-size:18px;font-weight:900;' +
            'margin:0 10px 6px 0;opacity:.7;">' + esc(icon) + '</span>';
    }

    function badge(text, ok) {
        return '<span style="display:inline-block;padding:2px 10px;border-radius:999px;' +
            'background:' + (ok ? "#16a34a" : "#ef4444") + ';color:#fff;font-size:11px;font-weight:900;' +
            'margin-left:8px;border:1px solid rgba(0,0,0,.35);">' + esc(text) + "</span>";
    }

    function mini(label, cmd, title) {
        return '<a title="' + esc(title || "") + '" style="' +
            'display:inline-block;padding:2px 10px;border-radius:999px;background:#fff;border:2px solid #111;' +
            'text-decoration:none;color:#111;font-size:11px;font-weight:900;margin:0 8px 6px 0;" href="' + esc(cmd) + '">' +
            esc(label) + '</a>';
    }

    function miniDisabled(label, title) {
        return '<span title="' + esc(title || "") + '" style="' +
            'display:inline-block;padding:2px 10px;border-radius:999px;background:#e5e7eb;border:2px solid #9ca3af;' +
            'color:#6b7280;font-size:11px;font-weight:900;margin:0 8px 6px 0;opacity:.75;">' + esc(label) + '</span>';
    }

    function doorBits(d) {
        var bits = [];
        bits.push(d.get("isOpen") ? "open" : "closed");
        bits.push(d.get("isLocked") ? "locked" : "unlocked");
        bits.push(d.get("isSecret") ? "secret" : "revealed");
        return bits.join(", ");
    }

    /* ---------- group ops ---------- */
    function getOrCreateGroup(name) {
        var st = ensureState();
        st.groups[name] = st.groups[name] || {
            required: 0,
            plates: [],
            doors: {},

            locked: false,       // trigger lock
            lockFreeze: false,   // freeze door state when locked

            cfgLocked: false,    // config lock
            autoLock: false,     // auto lock after first trigger
            hasTriggered: false,

            msgOn: "",
            msgOff: "",
            lastActive: false
        };

        // backfill
        var g = st.groups[name];
        if (typeof g.locked === "undefined") g.locked = false;
        if (typeof g.lockFreeze === "undefined") g.lockFreeze = false;
        if (typeof g.cfgLocked === "undefined") g.cfgLocked = false;
        if (typeof g.autoLock === "undefined") g.autoLock = false;
        if (typeof g.hasTriggered === "undefined") g.hasTriggered = false;
        if (!g.doors) g.doors = {};
        if (!g.plates) g.plates = [];
        if (typeof g.required === "undefined") g.required = 0;

        if (typeof g.msgOn === "undefined") g.msgOn = "";
        if (typeof g.msgOff === "undefined") g.msgOff = "";
        if (typeof g.lastActive === "undefined") g.lastActive = false;

        return g;
    }

    function groupAddPlateId(g, plateId) {
        for (var i = 0; i < g.plates.length; i++) if (g.plates[i] === plateId) return false;
        g.plates.push(plateId);
        return true;
    }

    function describeTeleportDestination(trap) {
        if (!trap || !trap.teleport || !trap.teleport.pageId) return "(not set)";
        return (trap.teleport.name || "Destination") + " @ …" + shortId(trap.teleport.pageId);
    }

    function describeRevealTargets(trap) {
        var out = [];
        var refs = (trap && trap.revealTargets) ? trap.revealTargets : [];

        for (var i = 0; i < refs.length; i++) {
            var ref = String(refs[i] || "");
            var parts = ref.split(":");
            if (parts.length !== 2) continue;

            var type = parts[0];
            var id = parts[1];
            var obj = getObj(type, id);
            if (!obj) continue;

            if (type === "graphic") {
                out.push((obj.get("name") || "Graphic") + " …" + shortId(id));
            } else if (type === "door") {
                out.push("Door …" + shortId(id));
            }
        }

        return out.length ? out.join(", ") : "(none)";
    }

    /* ---------- commands: singles ---------- */
    function cmdMakePlateFromSelected(msg, plateName) {
        var sel = msg.selected || [];

        if (!sel.length) {
            whisper("Select one or more tokens, then run <code>!plate make</code>.");
            return;
        }

        var base = String(plateName || "").trim();
        if (!base) base = "Plate";

        var made = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;

            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                made++;
                o.set({ layer: "gmlayer" });

                var newName = base;
                if (sel.length > 1) newName = base + "_" + made;

                o.set({ name: newName });

                ensurePlateData(o.id);
            }
        }

        setUIPage(msg.playerid);
        evaluateAll();
        renderUI(msg.playerid);
    }

    function cmdAddSingle(msg, mode) {
        mode = (mode || "").toLowerCase();
        if (mode !== "lock" && mode !== "secret") {
            whisper("Use <code>!plate add lock</code> or <code>!plate add secret</code>.");
            return;
        }

        var st = ensureState();
        var sel = msg.selected || [];
        var plate = null;
        var doors = [];

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token" && o.get("layer") === "gmlayer") plate = o;
            if (o.get("_type") === "door") doors.push(o);
        }

        if (!plate) { whisper("Select a plate token (GM layer) and one or more Door objects."); return; }
        if (!doors.length) { whisper("No Door objects selected (must be Door tool doors)."); return; }

        ensurePlateData(plate.id);
        for (var d = 0; d < doors.length; d++) st.plates[plate.id].doors[doors[d].id] = mode;

        evaluatePlate(plate.id);
        renderUI(msg.playerid);
    }

    function cmdSimOpen(plateId) {
        var st = ensureState();
        var pdata = st.plates[plateId];
        if (!pdata || !pdata.doors) return;
        for (var doorId in pdata.doors) {
            if (!pdata.doors.hasOwnProperty(doorId)) continue;
            applyOccupied(getObj("door", doorId), pdata.doors[doorId]);
        }
    }

    function cmdSimClose(plateId) {
        var st = ensureState();
        var pdata = st.plates[plateId];
        if (!pdata || !pdata.doors) return;
        for (var doorId in pdata.doors) {
            if (!pdata.doors.hasOwnProperty(doorId)) continue;
            applyUnoccupied(getObj("door", doorId), pdata.doors[doorId]);
        }
    }

    function cmdRemovePlate(plateId) {
        var st = ensureState();
        delete st.plates[plateId];

        // Also remove it from any groups
        for (var gname in st.groups) {
            if (!st.groups.hasOwnProperty(gname)) continue;
            var g = st.groups[gname];
            var out = [];
            for (var i = 0; i < g.plates.length; i++) if (g.plates[i] !== plateId) out.push(g.plates[i]);
            g.plates = out;
        }
    }

    function cmdSetPlateMsgOn(plateId, msgText) {
        var p = ensurePlateData(plateId);
        p.msgOn = String(msgText || "");
        whisper("Plate …" + esc(shortId(plateId)) + " trigger message set.");
    }

    function cmdSetPlateMsgOff(plateId, msgText) {
        var p = ensurePlateData(plateId);
        p.msgOff = String(msgText || "");
        whisper("Plate …" + esc(shortId(plateId)) + " release message set.");
    }

    function cmdTrapToggle(plateId) {
        var p = ensurePlateData(plateId);
        p.trap.enabled = !p.trap.enabled;
        if (p.trap.enabled && p.trap.type === "none") p.trap.type = "alarm";
        whisper("Plate …" + esc(shortId(plateId)) + " trap is now " + (p.trap.enabled ? "<b>ENABLED</b>" : "<b>DISABLED</b>") + ".");
    }

    function cmdTrapType(plateId, type) {
        var p = ensurePlateData(plateId);
        type = String(type || "").toLowerCase();

        if (!TRAP_TYPES[type]) {
            whisper("Trap type must be one of: <code>alarm</code>, <code>damage</code>, <code>teleport</code>, <code>reveal</code>, <code>none</code>.");
            return;
        }

        p.trap.type = type;
        p.trap.enabled = (type !== "none");
        whisper("Plate …" + esc(shortId(plateId)) + " trap type set to <b>" + esc(trapTypeLabel(type).toUpperCase()) + "</b>.");
    }

    function cmdTrapTrigger(plateId, trigger) {
        var p = ensurePlateData(plateId);
        trigger = String(trigger || "").toLowerCase();

        if (!TRAP_TRIGGERS[trigger]) {
            whisper("Trap trigger must be <code>press</code>, <code>release</code>, or <code>both</code>.");
            return;
        }

        p.trap.trigger = trigger;
        whisper("Plate …" + esc(shortId(plateId)) + " trap trigger set to <b>" + esc(trapTriggerLabel(trigger).toUpperCase()) + "</b>.");
    }

    function cmdTrapMessage(plateId, msgText) {
        var p = ensurePlateData(plateId);
        p.trap.message = String(msgText || "");
        whisper("Plate …" + esc(shortId(plateId)) + " trap message set.");
    }

    function cmdTrapDamage(plateId, dmgExpr) {
        var p = ensurePlateData(plateId);
        p.trap.damage = String(dmgExpr || "").trim() || "1d6";
        whisper("Plate …" + esc(shortId(plateId)) + " damage roll set to <b>" + esc(p.trap.damage) + "</b>.");
    }

    function cmdTrapSetTeleport(msg, plateId) {
        var p = ensurePlateData(plateId);
        var sel = msg.selected || [];
        var marker = null;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.id !== plateId) {
                marker = o;
                break;
            }
        }

        if (!marker) {
            whisper("Select one destination token/graphic, then run <code>!plate trapsetteleport " + esc(plateId) + "</code>.");
            return;
        }

        p.trap.teleport = {
            pageId: marker.get("_pageid"),
            left: marker.get("left"),
            top: marker.get("top"),
            name: marker.get("name") || ("Marker …" + shortId(marker.id))
        };
        whisper("Teleport destination saved for plate …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapClearTeleport(plateId) {
        var p = ensurePlateData(plateId);
        p.trap.teleport = defaultTrapConfig().teleport;
        whisper("Teleport destination cleared for plate …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapSetReveal(msg, plateId) {
        var p = ensurePlateData(plateId);
        var sel = msg.selected || [];
        var refs = [];

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.id === plateId) continue;

            if (o.get("_type") === "graphic" || o.get("_type") === "door") {
                refs.push(o.get("_type") + ":" + o.id);
            }
        }

        if (!refs.length) {
            whisper("Select one or more hidden graphics or secret doors, then run <code>!plate trapsetreveal " + esc(plateId) + "</code>.");
            return;
        }

        p.trap.revealTargets = refs;
        whisper("Reveal targets saved for plate …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapClearReveal(plateId) {
        var p = ensurePlateData(plateId);
        p.trap.revealTargets = [];
        whisper("Reveal targets cleared for plate …" + esc(shortId(plateId)) + ".");
    }

    function renderTrapUI(playerid, plateId) {
        var plate = getObj("graphic", plateId);
        if (!plate) return whisper("Plate not found.");

        var pdata = ensurePlateData(plateId);
        var trap = pdata.trap;
        var occ = isPlateOccupied(plate);
        var name = plate.get("name") || ("Plate …" + shortId(plateId));
        var enabled = trap.enabled && trap.type !== "none";
        var triggerHint = enabled ? (trapTypeLabel(trap.type) + " / " + trapTriggerLabel(trap.trigger)) : "Disabled";

        var html = "";
        html += '<div style="border:2px solid #111;border-radius:12px;overflow:hidden;max-width:760px;font-family:Arial,sans-serif;">';
        html += '<div style="background:#000;color:#fff;padding:10px 12px;">';
        html += '<div style="font-weight:900;font-size:20px;">Trap Configuration</div>';
        html += '<div style="color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;">' + esc(name) + " • " + esc(triggerHint) + "</div>";
        html += "</div>";
        html += '<div style="background:#fff;padding:10px;">';

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += badge(occ ? "OCCUPIED" : "CLEAR", occ);
        html += enabled ? badge("TRAP ENABLED", false) : badge("TRAP DISABLED", false);
        html += '<div style="margin-top:8px;">';
        html += iconBtn("↩️", "!plate ui", "Back to plate list");
        html += iconBtn("💣", "!plate traptoggle " + plateId, enabled ? "Disable trap" : "Enable trap");
        html += iconBtn("🔄", "!plate trapui " + plateId, "Refresh trap configuration");
        html += "</div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Trap Type</div>';
        html += mini("Alarm", "!plate traptype " + plateId + " alarm", "Narration or warning trap");
        html += mini("Damage", "!plate traptype " + plateId + " damage", "Damage trap");
        html += mini("Teleport", "!plate traptype " + plateId + " teleport", "Teleport occupants");
        html += mini("Reveal", "!plate traptype " + plateId + " reveal", "Reveal hidden targets");
        html += mini("Disable", "!plate traptype " + plateId + " none", "Disable trap without removing plate");
        html += '<div style="margin-top:8px;font-weight:900;">Current type: <span style="color:#333;">' + esc(trapTypeLabel(trap.type)) + "</span></div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Trigger</div>';
        html += mini("Press", "!plate traptrigger " + plateId + " press", "Fire when the plate is pressed");
        html += mini("Release", "!plate traptrigger " + plateId + " release", "Fire when the plate is released");
        html += mini("Both", "!plate traptrigger " + plateId + " both", "Fire on press and release");
        html += '<div style="margin-top:8px;font-weight:900;">Current trigger: <span style="color:#333;">' + esc(trapTriggerLabel(trap.trigger)) + "</span></div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Messaging</div>';
        html += mini("Set message", "!plate trapmsg " + plateId + " ?{Trap message|}", "Optional narration when the trap fires");
        html += '<div style="margin-top:8px;font-weight:900;">Message: <span style="color:#333;">' + esc(String(trap.message || "").trim() || "(none)") + "</span></div>";
        html += "</div>";

        if (trap.type === "damage") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Damage Settings</div>';
            html += mini("Set damage", "!plate trapdamage " + plateId + " ?{Damage roll|1d6}", "Roll expression for the damage trap");
            html += '<div style="margin-top:8px;font-weight:900;">Damage: <span style="color:#333;">' + esc(trap.damage) + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "teleport") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Teleport Settings</div>';
            html += mini("Set destination from selection", "!plate trapsetteleport " + plateId, "Select one marker graphic, then click");
            html += mini("Clear destination", "!plate trapclearteleport " + plateId, "Remove teleport destination");
            html += '<div style="margin-top:8px;font-weight:900;">Destination: <span style="color:#333;">' + esc(describeTeleportDestination(trap)) + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "reveal") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Reveal Settings</div>';
            html += mini("Set reveal targets from selection", "!plate trapsetreveal " + plateId, "Select graphics or doors to reveal, then click");
            html += mini("Clear reveal targets", "!plate trapclearreveal " + plateId, "Remove reveal target list");
            html += '<div style="margin-top:8px;font-weight:900;">Targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
            html += "</div>";
        }

        html += "</div></div>";
        whisper(html);
    }

    /* ---------- commands: groups ---------- */
    function cmdGroupMakeFromSelected(msg, name, required) {
        if (!name) { whisper("Usage: <code>!plate groupmake NAME [K]</code>"); return; }
        if (!requireConfigEditable(name)) return;

        var g = getOrCreateGroup(name);
        required = parseInt(required, 10);
        if (isNaN(required) || required < 0) required = 0;
        g.required = required;

        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                ensurePlateData(o.id);

                if (groupAddPlateId(g, o.id)) added++;
            }
        }

        whisper("Group <b>" + esc(name) + "</b> updated. Added <b>" + esc(String(added)) + "</b> plate(s).");
    }

    function cmdGroupAddPlates(msg, name) {
        if (!name) { whisper("Usage: <code>!plate groupaddplates NAME</code>"); return; }
        if (!requireConfigEditable(name)) return;

        var g = getOrCreateGroup(name);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                ensurePlateData(o.id);

                if (groupAddPlateId(g, o.id)) added++;
            }
        }

        whisper("Added <b>" + esc(String(added)) + "</b> plate(s) to group <b>" + esc(name) + "</b>.");
    }

    function cmdGroupAddDoors(msg, name, mode) {
        if (!name) { whisper("Usage: <code>!plate groupadddoors NAME lock|secret</code>"); return; }
        if (!requireConfigEditable(name)) return;

        mode = (mode || "").toLowerCase();
        if (mode !== "lock" && mode !== "secret") {
            whisper("Usage: select Door object(s), then <code>!plate groupadddoors " + esc(name) + " lock</code> or <code>... secret</code>.");
            return;
        }

        var g = getOrCreateGroup(name);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "door") {
                g.doors[o.id] = mode;
                added++;
            }
        }

        whisper("Added <b>" + esc(String(added)) + "</b> door(s) to group <b>" + esc(name) + "</b> as <b>" + esc(mode.toUpperCase()) + "</b>.");
    }

    function cmdGroupSetAll(name) {
        if (!requireConfigEditable(name)) return;
        var g = getOrCreateGroup(name);
        g.required = 0;
        whisper("Group <b>" + esc(name) + "</b> now requires <b>ALL</b> plates.");
    }

    function cmdGroupSetK(name, k) {
        if (!requireConfigEditable(name)) return;
        var g = getOrCreateGroup(name);
        k = parseInt(k, 10);
        if (isNaN(k) || k < 1) { whisper("K must be a number >= 1."); return; }
        g.required = k;
        whisper("Group <b>" + esc(name) + "</b> now requires <b>" + esc(String(k)) + "</b> plate(s).");
    }

    // Trigger lock toggle
    function cmdToggleGroupLock(name) {
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return whisper("Group not found: " + esc(name));

        // If it was frozen due to autoLock, unlocking clears freeze.
        if (g.locked && g.lockFreeze) g.lockFreeze = false;

        g.locked = !g.locked;

        whisper("Group <b>" + esc(name) + "</b> is now " + (g.locked ? "<b>LOCKED</b> (mechanism disabled)" : "<b>UNLOCKED</b>") + ".");
    }

    // Config lock toggle
    function cmdToggleGroupCfgLock(name) {
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return whisper("Group not found: " + esc(name));

        g.cfgLocked = !g.cfgLocked;

        // Clear any override when locking
        if (g.cfgLocked) delete st.editOverride[name];

        whisper("Group <b>" + esc(name) + "</b> config is now " + (g.cfgLocked ? "<b>CONFIG LOCKED</b>" : "<b>CONFIG UNLOCKED</b>") + ".");
    }

    // GM override for config lock (60s)
    function cmdGroupOverride(name) {
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return whisper("Group not found: " + esc(name));

        st.editOverride[name] = Date.now() + OVERRIDE_MS;
        whisper("Override enabled for group <b>" + esc(name) + "</b> for <b>60 seconds</b>.");
    }

    // Auto-lock toggle
    function cmdToggleGroupAutoLock(name) {
        if (!requireConfigEditable(name)) return;

        var st = ensureState();
        var g = st.groups[name];
        if (!g) return whisper("Group not found: " + esc(name));

        g.autoLock = !g.autoLock;

        whisper("Group <b>" + esc(name) + "</b> Auto-lock after first trigger is now " + (g.autoLock ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdGroupResetTrigger(name) {
        if (!requireConfigEditable(name)) return;
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return whisper("Group not found: " + esc(name));

        g.hasTriggered = false;

        // If it was frozen due to auto-lock, clear that too.
        if (g.locked && g.lockFreeze) {
            g.locked = false;
            g.lockFreeze = false;
        }

        whisper("Group <b>" + esc(name) + "</b> trigger state reset (hasTriggered = false).");
    }

    function cmdGroupRemove(name) {
        var st = ensureState();
        delete st.groups[name];
        delete st.editOverride[name];
        whisper("Removed group <b>" + esc(name) + "</b>.");
    }

    function cmdGroupDelPlate(name, plateId) {
        if (!requireConfigEditable(name)) return;
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return;

        var out = [];
        for (var i = 0; i < g.plates.length; i++) if (g.plates[i] !== plateId) out.push(g.plates[i]);
        g.plates = out;
        whisper("Removed plate …" + esc(shortId(plateId)) + " from group <b>" + esc(name) + "</b>.");
    }

    function cmdGroupDelDoor(name, doorId) {
        if (!requireConfigEditable(name)) return;
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return;

        delete g.doors[doorId];
        whisper("Detached door …" + esc(shortId(doorId)) + " from group <b>" + esc(name) + "</b>.");
    }

    function cmdSetGroupMsgOn(name, msgText) {
        if (!requireConfigEditable(name)) return;
        var g = getOrCreateGroup(name);
        g.msgOn = String(msgText || "");
        whisper("Group <b>" + esc(name) + "</b> trigger message set.");
    }

    function cmdSetGroupMsgOff(name, msgText) {
        if (!requireConfigEditable(name)) return;
        var g = getOrCreateGroup(name);
        g.msgOff = String(msgText || "");
        whisper("Group <b>" + esc(name) + "</b> release message set.");
    }

    /* ---------- UI rendering ---------- */
    function renderUI(playerid) {
        var st = ensureState();
        var pageId = getUIPage(playerid);
        var pageName = getUIPageName(pageId);
        var suggested = safeGroupNameFromPage(pageName);

        var html = "";
        html += '<div style="border:2px solid #111;border-radius:12px;overflow:hidden;max-width:860px;font-family:Arial,sans-serif;">';

        // header
        html += '<div style="background:#000;color:#fff;padding:10px 12px;">';
        html += '<div style="font-weight:900;font-size:20px;">Pressure Plate List</div>';
        html += '<div style="color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;">UI Page: ' + esc(pageName) + ' (…' + esc(shortId(pageId)) + ')</div>';
        html += "</div>";

        // body
        html += '<div style="background:#fff;padding:10px;">';

        // global controls
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Controls</div>';
        html += iconBtn("🧱", "!plate make ?{Plate name|Pressure_Plate}", "Make Plate from selected (moves to GM layer)");
        html += iconBtn("🧭", "!plate setpage", "Use Current Page (Set)");
        html += iconBtn("🔄", "!plate ui", "Refresh UI");
        html += iconBtn("✅", "!plate check", "Force Check all plates/groups");
        html += "</div>";

        // group tools
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Group Tools</div>';
        html += '<div style="color:#333;font-weight:900;margin-bottom:8px;">Suggested name: <span style="font-family:monospace;">' + esc(suggested) + "</span></div>";

        html += mini("Create group from selected plates", "!plate groupmake ?{Group Name (no spaces)|" + esc(suggested) + "} ?{Required K (0=ALL)|0}", "Create/Update group and add selected plates");
        html += mini("Add selected plates to group", "!plate groupaddplates ?{Group Name (no spaces)|" + esc(suggested) + "}", "Add selected plates to named group");
        html += mini("Add selected doors LOCK", "!plate groupadddoors ?{Group Name (no spaces)|" + esc(suggested) + "} lock", "Bind selected door(s) to group as LOCK");
        html += mini("Add selected doors SECRET", "!plate groupadddoors ?{Group Name (no spaces)|" + esc(suggested) + "} secret", "Bind selected door(s) to group as SECRET");
        html += "</div>";

        /* ---------- singles ---------- */
        html += '<div style="border:2px solid #111;border-radius:10px;margin-bottom:12px;">';
        html += '<div style="padding:8px 10px;border-bottom:2px solid #111;background:#f3f4f6;">';
        html += '<span style="font-weight:900;font-size:18px;">Single Plates</span>';
        html += '<span style="color:#444;font-weight:900;margin-left:10px;">(1 plate → doors)</span>';
        html += "</div>";

        var anySingle = false;

        for (var pid in st.plates) {
            if (!st.plates.hasOwnProperty(pid)) continue;
            var pObj = getObj("graphic", pid);
            if (!pObj || pObj.get("_pageid") !== pageId) continue;

            anySingle = true;

            var occ = isPlateOccupied(pObj);
            var name = pObj.get("name") || ("Plate …" + shortId(pid));
            var pdata = ensurePlateData(pid);
            var doors = pdata.doors || {};
            var trap = pdata.trap || defaultTrapConfig();
            var trapEnabled = trap.enabled && trap.type !== "none";

            html += '<div style="border-top:2px solid #111;">';
            html += '<div style="padding:8px 10px;border-bottom:2px solid #111;">';
            html += '<span style="font-weight:900;font-size:18px;">' + esc(name) + "</span>" +
                badge(occ ? "OCCUPIED" : "CLEAR", occ);
            if (trapEnabled) html += badge("TRAP", false);
            html += "</div>";

            html += '<div style="padding:8px 10px;">';
            html += iconBtn("🔍", "!plate ping " + pid, "Ping plate");
            html += iconBtn("✅", "!plate checkplate " + pid, "Check plate");
            html += iconBtn("⬆️", "!plate simopen " + pid, "Force open (simulate pressed)");
            html += iconBtn("⬇️", "!plate simclose " + pid, "Force close (simulate released)");
            html += iconBtn("🗑️", "!plate removeplate " + pid, "Remove plate");
            html += iconBtn("🔗", "!plate add lock", "Bind selected Door(s) to the selected plate as LOCK");
            html += iconBtn("👁️", "!plate add secret", "Bind selected Door(s) to the selected plate as SECRET");
            html += iconBtn("💣", "!plate trapui " + pid, trapEnabled ? "Open trap configuration" : "Convert this plate into a trap");
            // messages
            html += iconBtn("📣", "!plate platemsgon " + pid + " ?{Trigger message (plate pressed)|}", "Set trigger message (plate pressed)");
            html += iconBtn("🔕", "!plate platemsgoff " + pid + " ?{Release message (plate released)|}", "Set release message (plate released)");

            if (String(pdata.msgOn || "").trim()) {
                html += '<div style="margin-top:6px;color:#111;font-weight:900;">On: <span style="font-weight:700;">' + esc(pdata.msgOn) + "</span></div>";
            }
            if (String(pdata.msgOff || "").trim()) {
                html += '<div style="margin-top:4px;color:#111;font-weight:900;">Off: <span style="font-weight:700;">' + esc(pdata.msgOff) + "</span></div>";
            }

            var linked = [];
            var hasDoors = false;
            for (var did in doors) {
                if (!doors.hasOwnProperty(did)) continue;
                hasDoors = true;
                linked.push("…" + shortId(did));
            }

            html += '<div style="margin-top:6px;font-weight:900;">linked to: <span style="font-weight:900;color:#333;">' +
                (hasDoors ? esc(linked.join(", ")) : "(none)") + "</span></div>";

            html += '<div style="margin-top:6px;font-weight:900;">trap: <span style="font-weight:900;color:#333;">' +
                esc(trapEnabled ? (trapTypeLabel(trap.type) + " / " + trapTriggerLabel(trap.trigger)) : "(disabled)") + "</span></div>";

            for (var did2 in doors) {
                if (!doors.hasOwnProperty(did2)) continue;
                var dd = getObj("door", did2);
                if (!dd) continue;
                html += '<div style="margin-left:12px;margin-top:4px;color:#111;font-weight:900;">' +
                    esc(String(doors[did2]).toUpperCase()) + " door …" + esc(shortId(did2)) +
                    ' <span style="color:#666;">(' + esc(doorBits(dd)) + ")</span></div>";
            }

            html += "</div></div>";
        }

        if (!anySingle) {
            html += '<div style="padding:10px;color:#666;font-weight:900;">(No single plates on this page)</div>';
        }

        html += "</div>";

        /* ---------- groups ---------- */
        html += '<div style="border:2px solid #111;border-radius:10px;">';
        html += '<div style="padding:8px 10px;border-bottom:2px solid #111;background:#f3f4f6;">';
        html += '<span style="font-weight:900;font-size:18px;">Groups</span>';
        html += '<span style="color:#444;font-weight:900;margin-left:10px;">(K-of-N plates → doors)</span>';
        html += "</div>";

        var anyGroup = false;

        for (var gname in st.groups) {
            if (!st.groups.hasOwnProperty(gname)) continue;
            var g = st.groups[gname];

            // show only if any plate in group is on this page
            var show = false;
            for (var j = 0; j < g.plates.length; j++) {
                var gp = getObj("graphic", g.plates[j]);
                if (gp && gp.get("_pageid") === pageId) { show = true; break; }
            }
            if (!show) continue;

            anyGroup = true;

            pruneGroup(g);

            var pressed = groupPressedCount(g);
            var required = clampRequired(g);
            var active = (!g.locked) && (pressed >= required);

            var lockIcon = g.locked ? "🔒" : "🔓";
            var cfgIcon = g.cfgLocked ? "🧱" : "✏️";
            var autoIcon = g.autoLock ? "⭐" : "☆";

            var overrideActive = hasEditOverride(gname);
            var editBlocked = g.cfgLocked && !overrideActive;
            var lockText = g.locked ? (g.lockFreeze ? "FROZEN" : "LOCKED") : "UNLOCKED";

            html += '<div style="border-top:2px solid #111;">';
            html += '<div style="padding:8px 10px;border-bottom:2px solid #111;">';
            html += '<span style="font-weight:900;font-size:18px;">' + esc(gname) + "</span>";
            html += badge(active ? "ACTIVE" : "INACTIVE", active);
            if (g.locked) html += badge(lockText, false);
            if (g.cfgLocked) html += badge("CONFIG", false);
            if (overrideActive) html += badge("OVERRIDE", true);
            if (g.autoLock) html += badge("AUTOLOCK", true);
            html += '<span style="color:#444;font-weight:900;margin-left:8px;">(' + esc(String(pressed)) + "/" + esc(String(required)) + " pressed)</span>";
            html += "</div>";

            html += '<div style="padding:8px 10px;">';

            // always-available controls
            html += iconBtn(lockIcon, "!plate grouplock " + gname, g.locked ? "Unlock mechanism" : "Lock mechanism (disable)");
            html += iconBtn("✅", "!plate groupcheck " + gname, "Check group now");
            html += iconBtn(cfgIcon, "!plate groupcfglock " + gname, g.cfgLocked ? "Unlock config (allow edits)" : "Lock config (prevent edits)");

            if (g.cfgLocked) html += iconBtn("⚡", "!plate groupoverride " + gname, "Override config lock for 60s");
            else html += iconBtnDisabled("⚡", "Override only needed when config locked");

            // auto-lock toggle
            if (editBlocked) html += iconBtnDisabled(autoIcon, "Config locked (use Override to change auto-lock)");
            else html += iconBtn(autoIcon, "!plate groupautolock " + gname, g.autoLock ? "Auto-lock after first trigger: ON (click to disable)" : "Auto-lock after first trigger: OFF (click to enable)");

            // reset trigger
            if (editBlocked) html += iconBtnDisabled("🔁", "Config locked (use Override to reset trigger)");
            else html += iconBtn("🔁", "!plate groupreset " + gname, "Reset hasTriggered (and unfreeze if auto-locked)");

            // edit controls
            if (editBlocked) {
                html += iconBtnDisabled("➕", "Config locked");
                html += iconBtnDisabled("🔗", "Config locked");
                html += iconBtnDisabled("👁️", "Config locked");
                html += iconBtnDisabled("🗑️", "Config locked");
            } else {
                html += iconBtn("➕", "!plate groupaddplates " + gname, "Add selected plates to this group");
                html += iconBtn("🔗", "!plate groupadddoors " + gname + " lock", "Add selected doors as LOCK");
                html += iconBtn("👁️", "!plate groupadddoors " + gname + " secret", "Add selected doors as SECRET");
                html += iconBtn("🗑️", "!plate groupremove " + gname, "Remove group");
            }

            // group messages (edit-gated)
            if (editBlocked) {
                html += iconBtnDisabled("📣", "Config locked");
                html += iconBtnDisabled("🔕", "Config locked");
            } else {
                html += iconBtn("📣", "!plate groupmsgon " + gname + " ?{Trigger message (group active)|}", "Set trigger message (group active)");
                html += iconBtn("🔕", "!plate groupmsgoff " + gname + " ?{Release message (group inactive)|}", "Set release message (group inactive)");
            }

            if (String(g.msgOn || "").trim()) {
                html += '<div style="margin-top:6px;color:#111;font-weight:900;">On: <span style="font-weight:700;">' + esc(g.msgOn) + "</span></div>";
            }
            if (String(g.msgOff || "").trim()) {
                html += '<div style="margin-top:4px;color:#111;font-weight:900;">Off: <span style="font-weight:700;">' + esc(g.msgOff) + "</span></div>";
            }

            // requirement controls
            html += "<div style='margin-top:6px;'></div>";
            if (editBlocked) {
                html += miniDisabled("Require ALL", "Config locked");
                html += miniDisabled("Set K…", "Config locked");
            } else {
                html += mini("Require ALL", "!plate groupsetall " + gname, "Require ALL plates in group");
                html += mini("Set K…", "!plate groupsetk " + gname + " ?{Require how many plates?|2}", "Set required K (K-of-N)");
            }

            // plates list
            html += '<div style="margin-top:10px;font-weight:900;">Plates (this page)</div>';
            var anyPlateListed = false;
            for (var k = 0; k < g.plates.length; k++) {
                var pp = getObj("graphic", g.plates[k]);
                if (!pp) continue;
                if (pp.get("_pageid") !== pageId) continue;

                anyPlateListed = true;

                var pocc = isPlateOccupied(pp);
                var pname = pp.get("name") || ("Plate …" + shortId(pp.id));

                html += '<div style="margin-left:12px;margin-top:6px;font-weight:900;">' +
                    esc(pname) + badge(pocc ? "DOWN" : "UP", pocc) +
                    mini("Ping", "!plate ping " + pp.id, "Ping this plate");

                if (editBlocked) html += miniDisabled("Remove", "Config locked");
                else html += mini("Remove", "!plate groupdelplate " + gname + " " + pp.id, "Remove this plate from the group");

                html += "</div>";
            }
            if (!anyPlateListed) {
                html += '<div style="margin-left:12px;margin-top:6px;color:#666;font-weight:900;">(No plates from this group on this page)</div>';
            }

            // doors list
            html += '<div style="margin-top:12px;font-weight:900;">Doors</div>';
            var hasGDoors = false;
            for (var did3 in g.doors) {
                if (!g.doors.hasOwnProperty(did3)) continue;
                hasGDoors = true;
                var d3 = getObj("door", did3);
                if (!d3) continue;

                html += '<div style="margin-left:12px;margin-top:6px;font-weight:900;">' +
                    esc(String(g.doors[did3]).toUpperCase()) + " door …" + esc(shortId(did3)) +
                    ' <span style="color:#666;">(' + esc(doorBits(d3)) + ")</span> ";

                if (editBlocked) html += miniDisabled("Detach", "Config locked");
                else html += mini("Detach", "!plate groupdeldor " + gname + " " + did3, "Detach this door from group");

                html += "</div>";
            }
            if (!hasGDoors) {
                html += '<div style="margin-left:12px;margin-top:6px;color:#666;font-weight:900;">(No doors bound)</div>';
            }

            html += "</div></div>";
        }

        if (!anyGroup) {
            html += '<div style="padding:10px;color:#666;font-weight:900;">(No groups on this page)</div>';
        }

        html += "</div>"; // groups card
        html += "</div></div>"; // body + shell

        whisper(html);
    }

    /* ---------- events ---------- */
    on("change:graphic", function (obj, prev) {
        if (obj.get("layer") !== "objects") return;
        if (obj.get("_subtype") !== "token") return;

        if (
            obj.get("left") !== prev.left ||
            obj.get("top") !== prev.top ||
            obj.get("width") !== prev.width ||
            obj.get("height") !== prev.height ||
            obj.get("_pageid") !== prev._pageid
        ) {
            debouncedCheck();
        }
    });

    on("chat:message", function (msg) {
        if (msg.type !== "api") return;
        if (!playerIsGM(msg.playerid)) return;

        var parts = msg.content.split(/\s+/);
        if (parts[0] !== "!plate") return;

        var sub = (parts[1] || "").toLowerCase();
        var a = parts[2];
        var b = parts[3];

        // helper to capture the rest of the message (allows spaces)
        function restFrom(n) {
            return msg.content.split(/\s+/).slice(n).join(" ");
        }

        // UI / page
        if (sub === "ui") return renderUI(msg.playerid);
        if (sub === "setpage") { setUIPage(msg.playerid); return renderUI(msg.playerid); }

        // Singles
        if (sub === "make") return cmdMakePlateFromSelected(msg, a);
        if (sub === "add") { cmdAddSingle(msg, a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "check") { evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "checkplate") { if (a) evaluatePlate(a); return renderUI(msg.playerid); }
        if (sub === "simopen") { if (a) cmdSimOpen(a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "simclose") { if (a) cmdSimClose(a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "removeplate") { if (a) cmdRemovePlate(a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "trapui") { if (a) return renderTrapUI(msg.playerid, a); }
        if (sub === "traptoggle") { if (a) cmdTrapToggle(a); return renderTrapUI(msg.playerid, a); }
        if (sub === "traptype") { if (a) cmdTrapType(a, b); return renderTrapUI(msg.playerid, a); }
        if (sub === "traptrigger") { if (a) cmdTrapTrigger(a, b); return renderTrapUI(msg.playerid, a); }
        if (sub === "trapmsg") { if (a) cmdTrapMessage(a, restFrom(3)); return renderTrapUI(msg.playerid, a); }
        if (sub === "trapdamage") { if (a) cmdTrapDamage(a, restFrom(3)); return renderTrapUI(msg.playerid, a); }
        if (sub === "trapsetteleport") { if (a) cmdTrapSetTeleport(msg, a); return renderTrapUI(msg.playerid, a); }
        if (sub === "trapclearteleport") { if (a) cmdTrapClearTeleport(a); return renderTrapUI(msg.playerid, a); }
        if (sub === "trapsetreveal") { if (a) cmdTrapSetReveal(msg, a); return renderTrapUI(msg.playerid, a); }
        if (sub === "trapclearreveal") { if (a) cmdTrapClearReveal(a); return renderTrapUI(msg.playerid, a); }

        // Plate messages (allow spaces)
        if (sub === "platemsgon") { if (a) cmdSetPlateMsgOn(a, restFrom(3)); return renderUI(msg.playerid); }
        if (sub === "platemsgoff") { if (a) cmdSetPlateMsgOff(a, restFrom(3)); return renderUI(msg.playerid); }

        // Ping
        if (sub === "ping") { if (a) cmdPingPlate(msg.playerid, a); return; }

        // Groups
        if (sub === "groupmake") { cmdGroupMakeFromSelected(msg, a, b); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupaddplates") { cmdGroupAddPlates(msg, a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupadddoors") { cmdGroupAddDoors(msg, a, b); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupsetall") { cmdGroupSetAll(a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupsetk") { cmdGroupSetK(a, b); evaluateAll(); return renderUI(msg.playerid); }

        if (sub === "grouplock") { cmdToggleGroupLock(a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupcfglock") { cmdToggleGroupCfgLock(a); return renderUI(msg.playerid); }
        if (sub === "groupoverride") { cmdGroupOverride(a); return renderUI(msg.playerid); }

        if (sub === "groupautolock") { cmdToggleGroupAutoLock(a); return renderUI(msg.playerid); }
        if (sub === "groupreset") { cmdGroupResetTrigger(a); evaluateAll(); return renderUI(msg.playerid); }

        if (sub === "groupremove") { cmdGroupRemove(a); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupcheck") { evaluateGroup(a); return renderUI(msg.playerid); }
        if (sub === "groupdelplate") { cmdGroupDelPlate(a, b); evaluateAll(); return renderUI(msg.playerid); }
        if (sub === "groupdeldor") { cmdGroupDelDoor(a, b); evaluateAll(); return renderUI(msg.playerid); }

        // Group messages (allow spaces)
        if (sub === "groupmsgon") { if (a) cmdSetGroupMsgOn(a, restFrom(3)); return renderUI(msg.playerid); }
        if (sub === "groupmsgoff") { if (a) cmdSetGroupMsgOff(a, restFrom(3)); return renderUI(msg.playerid); }

        whisper(
            "Commands:<br>" +
            "<code>!plate ui</code>, <code>!plate setpage</code>, <code>!plate make NAME</code>, <code>!plate add lock|secret</code>, <code>!plate check</code>, <code>!plate ping PLATEID</code><br>" +
            "Trap UI:<br><code>!plate trapui PLATEID</code>, <code>!plate traptoggle PLATEID</code>, <code>!plate traptype PLATEID alarm|damage|teleport|reveal|none</code><br>" +
            "<code>!plate traptrigger PLATEID press|release|both</code>, <code>!plate trapmsg PLATEID ...</code>, <code>!plate trapdamage PLATEID XdY</code><br>" +
            "<code>!plate trapsetteleport PLATEID</code>, <code>!plate trapclearteleport PLATEID</code>, <code>!plate trapsetreveal PLATEID</code>, <code>!plate trapclearreveal PLATEID</code><br>" +
            "Plate Messages:<br><code>!plate platemsgon PLATEID ...</code>, <code>!plate platemsgoff PLATEID ...</code><br>" +
            "Groups:<br>" +
            "<code>!plate grouplock NAME</code> (mechanism lock), <code>!plate groupcfglock NAME</code> (config lock), <code>!plate groupoverride NAME</code> (60s override)<br>" +
            "<code>!plate groupautolock NAME</code>, <code>!plate groupreset NAME</code><br>" +
            "<code>!plate groupmake NAME [K]</code>, <code>!plate groupaddplates NAME</code>, <code>!plate groupadddoors NAME lock|secret</code><br>" +
            "<code>!plate groupmsgon NAME ...</code>, <code>!plate groupmsgoff NAME ...</code><br>" +
            "<code>!plate groupdelplate NAME PLATEID</code>, <code>!plate groupdeldor NAME DOORID</code>, <code>!plate groupremove NAME</code>"
        );
    });

    on("ready", function () {
        ensureState();
        evaluateAll();
        sendChat("", "/w gm Loaded ✅  UI: !plate ui   (State key: " + STATE + ")");
    });

    return {};
})();
