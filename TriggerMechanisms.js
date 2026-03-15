/* ============================================================
   TriggerMechanisms (ES5) — Teleport-Style UI + Ping + Locks + Messages
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

var TriggerMechanisms = TriggerMechanisms || (function () {
    "use strict";

    var MOD = "TriggerMechanisms";

    // >>> KEEP THIS THE SAME FOREVER (use your existing key) <<<
    // If your current working script uses a different key, replace this string with THAT key once.
    var STATE = "TM_CAMPAIGN_CORE";

    var DEBOUNCE_MS = 120;
    var OVERRIDE_MS = 60000; // 60s config override
    var TRAP_TYPES = { none: true, alarm: true, damage: true, teleport: true, reveal: true, save: true, status: true, spawn: true };
    var TRAP_TRIGGERS = { press: true, release: true, both: true };
    var MOVE_LOCK_REENTRY = {};

    function defaultTrapConfig() {
        return {
            enabled: false,
            type: "none",
            trigger: "press",
            message: "",
            damage: "1d6",
            save: {
                label: "DEX",
                dc: 12,
                successMsg: "",
                failMsg: "",
                successMode: "none",
                damageType: "",
                failDamage: ""
            },
            status: {
                markers: "cobweb",
                clearOnRelease: false,
                lastTargets: []
            },
            teleport: {
                pageId: "",
                left: 0,
                top: 0,
                name: ""
            },
            revealTargets: [],
            spawnTargets: [],
            effects: {
                lockToken: false,
                lockMarker: "fishing-net"
            }
        };
    }

    function backfillTrapConfig(trap) {
        trap = trap || {};

        if (typeof trap.enabled === "undefined") trap.enabled = false;
        if (!TRAP_TYPES[trap.type]) trap.type = "none";
        if (!TRAP_TRIGGERS[trap.trigger]) trap.trigger = "press";
        if (typeof trap.message === "undefined") trap.message = "";
        if (typeof trap.damage === "undefined") trap.damage = "1d6";

        trap.save = trap.save || {};
        if (typeof trap.save.label === "undefined") trap.save.label = "DEX";
        if (typeof trap.save.dc === "undefined") trap.save.dc = 12;
        if (typeof trap.save.successMsg === "undefined") trap.save.successMsg = "";
        if (typeof trap.save.failMsg === "undefined") trap.save.failMsg = "";
        if (trap.save.successMode !== "half" && trap.save.successMode !== "none") trap.save.successMode = "none";
        if (typeof trap.save.damageType === "undefined") trap.save.damageType = "";
        if (typeof trap.save.failDamage === "undefined") trap.save.failDamage = "";

        trap.status = trap.status || {};
        if (typeof trap.status.markers === "undefined") trap.status.markers = "cobweb";
        if (typeof trap.status.clearOnRelease === "undefined") trap.status.clearOnRelease = false;
        if (!trap.status.lastTargets) trap.status.lastTargets = [];

        trap.teleport = trap.teleport || {};
        if (typeof trap.teleport.pageId === "undefined") trap.teleport.pageId = "";
        if (typeof trap.teleport.left === "undefined") trap.teleport.left = 0;
        if (typeof trap.teleport.top === "undefined") trap.teleport.top = 0;
        if (typeof trap.teleport.name === "undefined") trap.teleport.name = "";

        if (!trap.revealTargets) trap.revealTargets = [];
        if (!trap.spawnTargets) trap.spawnTargets = [];

        trap.effects = trap.effects || {};
        if (typeof trap.effects.lockToken === "undefined") trap.effects.lockToken = false;
        if (typeof trap.effects.lockMarker === "undefined") trap.effects.lockMarker = "fishing-net";
        if (typeof trap.effects.revealAlso === "undefined") trap.effects.revealAlso = false;

        return trap;
    }

    function newSingleConfigData() {
        return {
            doors: {},
            msgOn: "",
            msgOff: "",
            lastActive: false,
            lastOccupants: [],
            trap: defaultTrapConfig()
        };
    }

    function newMechanismData(id) {
        return {
            id: id,
            kind: "single",
            legacyId: "",
            sourceKind: "pressurePlate",
            name: "",
            pageId: "",
            sources: [],
            rule: {
                mode: "single",
                k: 1,
                timing: "press"
            },
            effects: {
                doors: {},
                trap: null
            },
            messages: {
                on: "",
                off: ""
            },
            locks: {
                mechanismLocked: false,
                freezeWhenLocked: false,
                configLocked: false,
                autoLock: false,
                hasTriggered: false
            },
            runtime: {
                lastActive: false,
                lastOccupants: []
            }
        };
    }

    /* ---------- state ---------- */
    function ensureState() {
        state[STATE] = state[STATE] || {
            plates: {},        // legacy single-source config store
            groups: {},        // legacy multi-source config store
            mechanisms: {},    // mechanismId -> normalized internal model for all mechanisms
            uiPageId: null,
            last: 0,
            editOverride: {},  // mechanismName -> expiry timestamp
            lockedTokens: {}   // tokenId -> { sourceId, left, top, pageId, marker }
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
            if (!p.lastOccupants) p.lastOccupants = [];
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

        if (!st.mechanisms) st.mechanisms = {};
        if (!st.editOverride) st.editOverride = {};
        if (!st.lockedTokens) st.lockedTokens = {};

        return st;
    }

    function ensureSingleConfigData(plateId) {
        var st = ensureState();
        st.plates[plateId] = st.plates[plateId] || newSingleConfigData();

        var p = st.plates[plateId];
        if (!p.doors) p.doors = {};
        if (typeof p.msgOn === "undefined") p.msgOn = "";
        if (typeof p.msgOff === "undefined") p.msgOff = "";
        if (typeof p.lastActive === "undefined") p.lastActive = false;
        if (!p.lastOccupants) p.lastOccupants = [];
        p.trap = backfillTrapConfig(p.trap);

        return p;
    }

    function singleMechanismId(plateId) {
        return "single:" + plateId;
    }

    function multiMechanismId(mechanismName) {
        return "group:" + mechanismName;
    }

    function cloneDoorModes(doors) {
        var out = {};
        doors = doors || {};
        for (var did in doors) {
            if (!doors.hasOwnProperty(did)) continue;
            out[did] = doors[did];
        }
        return out;
    }

    function ensureMechanismData(mechId) {
        var st = ensureState();
        st.mechanisms[mechId] = st.mechanisms[mechId] || newMechanismData(mechId);
        return st.mechanisms[mechId];
    }

    function inferMechanismPageId(sourceIds) {
        for (var i = 0; i < sourceIds.length; i++) {
            var g = getObj("graphic", sourceIds[i]);
            if (g) return g.get("_pageid");
        }
        return "";
    }

    function syncSingleMechanismFromLegacy(plateId) {
        var plate = getObj("graphic", plateId);
        var pdata = ensureSingleConfigData(plateId);
        var mechId = singleMechanismId(plateId);
        var mech = ensureMechanismData(mechId);

        mech.kind = "single";
        mech.legacyId = plateId;
        mech.sourceKind = "pressurePlate";
        mech.name = (plate && plate.get("name")) || ("Trigger …" + shortId(plateId));
        mech.pageId = plate ? plate.get("_pageid") : "";
        mech.sources = [plateId];
        mech.rule.mode = "single";
        mech.rule.k = 1;
        mech.rule.timing = pdata.trap.trigger || "press";
        mech.effects.doors = cloneDoorModes(pdata.doors);
        mech.effects.trap = pdata.trap;
        mech.messages.on = pdata.msgOn || "";
        mech.messages.off = pdata.msgOff || "";
        mech.locks.mechanismLocked = false;
        mech.locks.freezeWhenLocked = false;
        mech.locks.configLocked = false;
        mech.locks.autoLock = false;
        mech.locks.hasTriggered = false;
        mech.runtime.lastActive = !!pdata.lastActive;
        mech.runtime.lastOccupants = (pdata.lastOccupants || []).slice();

        return mech;
    }

    function syncMultiMechanismFromLegacy(mechanismName) {
        var st = ensureState();
        var g = st.groups[mechanismName];
        if (!g) return null;

        var mechId = multiMechanismId(mechanismName);
        var mech = ensureMechanismData(mechId);
        var mode = (parseInt(g.required, 10) === 0) ? "all" : "kofn";

        mech.kind = "group";
        mech.legacyId = mechanismName;
        mech.sourceKind = "pressurePlate";
        mech.name = mechanismName;
        mech.pageId = inferMechanismPageId(g.plates || []);
        mech.sources = (g.plates || []).slice();
        mech.rule.mode = mode;
        mech.rule.k = clampRequiredSources(g);
        mech.rule.timing = "press";
        mech.effects.doors = cloneDoorModes(g.doors);
        mech.effects.trap = null;
        mech.messages.on = g.msgOn || "";
        mech.messages.off = g.msgOff || "";
        mech.locks.mechanismLocked = !!g.locked;
        mech.locks.freezeWhenLocked = !!g.lockFreeze;
        mech.locks.configLocked = !!g.cfgLocked;
        mech.locks.autoLock = !!g.autoLock;
        mech.locks.hasTriggered = !!g.hasTriggered;
        mech.runtime.lastActive = !!g.lastActive;
        mech.runtime.lastOccupants = [];

        return mech;
    }

    function syncAllMechanisms() {
        var st = ensureState();
        var keep = {};
        var mechId;
        var gname;
        var pid;

        for (pid in st.plates) {
            if (!st.plates.hasOwnProperty(pid)) continue;
            mechId = singleMechanismId(pid);
            syncSingleMechanismFromLegacy(pid);
            keep[mechId] = true;
        }

        for (gname in st.groups) {
            if (!st.groups.hasOwnProperty(gname)) continue;
            mechId = multiMechanismId(gname);
            syncMultiMechanismFromLegacy(gname);
            keep[mechId] = true;
        }

        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            if (!keep[mechId]) delete st.mechanisms[mechId];
        }
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

    function cmdPingSource(playerid, sourceId) {
        var p = getObj("graphic", sourceId);
        if (!p) return whisper("Trigger not found.");
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

    function isSourceOccupied(sourceGraphic) {
        return sourceOccupants(sourceGraphic).length > 0;
    }

    function sourceOccupants(sourceGraphic) {
        var pr = rect(sourceGraphic);
        var toks = tokensOnObjectsLayer(sourceGraphic.get("_pageid"));
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
        if (type === "save") return "Save";
        if (type === "status") return "Status";
        if (type === "spawn") return "Spawn";
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

    function getGraphicsByIds(ids) {
        var out = [];
        ids = ids || [];
        for (var i = 0; i < ids.length; i++) {
            var g = getObj("graphic", ids[i]);
            if (g) out.push(g);
        }
        return out;
    }

    function parseMarkerList(raw) {
        var seen = {};
        var out = [];
        raw = String(raw || "");
        var parts = raw.split(",");

        for (var i = 0; i < parts.length; i++) {
            var marker = String(parts[i] || "").replace(/^\s+|\s+$/g, "");
            if (!marker || seen[marker]) continue;
            seen[marker] = true;
            out.push(marker);
        }

        return out;
    }

    function applyMarkersToToken(token, markers) {
        if (!token || !markers.length) return;

        var current = parseMarkerList(token.get("statusmarkers"));
        var map = {};
        var out = [];
        var i;

        for (i = 0; i < current.length; i++) {
            map[current[i]] = true;
            out.push(current[i]);
        }
        for (i = 0; i < markers.length; i++) {
            if (map[markers[i]]) continue;
            out.push(markers[i]);
        }

        token.set({ statusmarkers: out.join(",") });
    }

    function removeMarkersFromToken(token, markers) {
        if (!token || !markers.length) return;

        var current = parseMarkerList(token.get("statusmarkers"));
        var removeMap = {};
        var out = [];
        var i;

        for (i = 0; i < markers.length; i++) removeMap[markers[i]] = true;
        for (i = 0; i < current.length; i++) if (!removeMap[current[i]]) out.push(current[i]);

        token.set({ statusmarkers: out.join(",") });
    }

    function lockTokenToCurrentPosition(token, sourceId, marker) {
        if (!token) return;

        var st = ensureState();
        st.lockedTokens[token.id] = {
            sourceId: sourceId,
            left: token.get("left"),
            top: token.get("top"),
            pageId: token.get("_pageid"),
            marker: marker || ""
        };

        if (marker) applyMarkersToToken(token, [marker]);
    }

    function maybeApplyLockEffect(sourceId, trap, tokens) {
        if (!trap.effects || !trap.effects.lockToken) return;
        for (var i = 0; i < tokens.length; i++) lockTokenToCurrentPosition(tokens[i], sourceId, trap.effects.lockMarker);
    }

    function unlockTokenById(tokenId) {
        var st = ensureState();
        var lock = st.lockedTokens[tokenId];
        if (!lock) return false;

        var token = getObj("graphic", tokenId);
        if (token && lock.marker) removeMarkersFromToken(token, [lock.marker]);
        delete st.lockedTokens[tokenId];
        return true;
    }

    function unlockTokensForSource(sourceId) {
        var st = ensureState();
        var count = 0;

        for (var tokenId in st.lockedTokens) {
            if (!st.lockedTokens.hasOwnProperty(tokenId)) continue;
            if (st.lockedTokens[tokenId].sourceId !== sourceId) continue;
            if (unlockTokenById(tokenId)) count++;
        }

        return count;
    }

    function lockedCountForSource(sourceId) {
        var st = ensureState();
        var count = 0;
        for (var tokenId in st.lockedTokens) {
            if (!st.lockedTokens.hasOwnProperty(tokenId)) continue;
            if (st.lockedTokens[tokenId].sourceId === sourceId) count++;
        }
        return count;
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

    function maybeApplyRevealEffect(trap) {
        if (!trap || !trap.revealTargets || !trap.revealTargets.length) return 0;
        return runRevealTargets(trap.revealTargets);
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

    function runSpawnTargets(refs) {
        var changed = 0;
        for (var i = 0; i < refs.length; i++) {
            var g = getObj("graphic", refs[i]);
            if (!g) continue;
            if (g.get("layer") === "gmlayer") {
                g.set({ layer: "objects" });
                changed++;
            }
        }
        return changed;
    }

    function formatSaveTrapMessage(targetNames, trap, customMsg) {
        var parts = [];
        var save = trap.save || {};
        var label = String(save.label || "DEX").toUpperCase();
        var dc = parseInt(save.dc, 10);
        var damageType = String(save.damageType || "").replace(/^\s+|\s+$/g, "");
        if (isNaN(dc) || dc < 1) dc = 12;

        if (customMsg) parts.push(customMsg);
        parts.push(targetNames + " must make a " + label + " save (DC " + dc + ").");
        if (String(save.successMsg || "").trim()) parts.push("Success: " + String(save.successMsg).trim() + ".");
        if (save.successMode === "half") {
            parts.push("Success: half of fail damage" + (damageType ? " (" + damageType + ")" : "") + ".");
        } else {
            parts.push("Success: no damage.");
        }
        if (String(save.failMsg || "").trim()) parts.push("Fail: " + String(save.failMsg).trim() + ".");
        if (String(save.failDamage || "").trim()) parts.push("Fail damage: [[" + String(save.failDamage).trim() + "]]" + (damageType ? " " + damageType : "") + ".");

        return parts.join(" ");
    }

    function firePlateTrap(plate, pdata, targets) {
        if (!plate || !pdata) return;

        var trap = backfillTrapConfig(pdata.trap);
        if (!trap.enabled || trap.type === "none") return;

        var plateName = plate.get("name") || ("Plate …" + shortId(plate.id));
        var targetNames = targets.length ? joinTokenNames(targets) : plateName;
        var customMsg = String(trap.message || "").trim();
        var revealCount = 0;

        if (trap.type !== "reveal" && trap.effects && trap.effects.revealAlso) {
            revealCount = maybeApplyRevealEffect(trap);
        }

        if (trap.type === "alarm") {
            postTriggerMessage(customMsg || ("Trap triggered at " + plateName + "."));
            maybeApplyLockEffect(plate.id, trap, targets);
            return;
        }

        if (trap.type === "damage") {
            postTriggerMessage((customMsg || "Trap hits") + ": " + targetNames + " take [[" + String(trap.damage || "1d6") + "]] damage.");
            maybeApplyLockEffect(plate.id, trap, targets);
            return;
        }

        if (trap.type === "teleport") {
            if (!trap.teleport.pageId) return;
            if (!targets.length) return;

            var moved = runTeleport(targets, trap.teleport);
            maybeApplyLockEffect(plate.id, trap, targets);
            if (moved && customMsg) postTriggerMessage(customMsg);
            return;
        }

        if (trap.type === "reveal") {
            var revealed = maybeApplyRevealEffect(trap);
            maybeApplyLockEffect(plate.id, trap, targets);
            if (revealed && customMsg) postTriggerMessage(customMsg);
            return;
        }

        if (trap.type === "save") {
            postTriggerMessage(formatSaveTrapMessage(targetNames, trap, customMsg));
            if (revealCount && !customMsg) postTriggerMessage("Hidden elements are revealed.");
            maybeApplyLockEffect(plate.id, trap, targets);
            return;
        }

        if (trap.type === "status") {
            var markers = parseMarkerList(trap.status.markers);
            for (var i = 0; i < targets.length; i++) applyMarkersToToken(targets[i], markers);
            trap.status.lastTargets = [];
            for (i = 0; i < targets.length; i++) trap.status.lastTargets.push(targets[i].id);
            if (customMsg) postTriggerMessage(customMsg);
            maybeApplyLockEffect(plate.id, trap, targets);
            return;
        }

        if (trap.type === "spawn") {
            var spawned = runSpawnTargets(trap.spawnTargets || []);
            if (spawned) postTriggerMessage(customMsg || ("Spawn trap triggered at " + plateName + "."));
            if (revealCount && !customMsg) postTriggerMessage("Hidden elements are revealed.");
            maybeApplyLockEffect(plate.id, trap, targets);
            return;
        }
    }

    /* ---------- evaluation: single plate ---------- */
    function countActiveMechanismSources(mech) {
        var count = 0;
        for (var i = 0; i < mech.sources.length; i++) {
            var source = getObj("graphic", mech.sources[i]);
            if (!source) continue;
            if (isSourceOccupied(source)) count++;
        }
        return count;
    }

    function applyDoorEffects(doors, active) {
        for (var doorId in doors) {
            if (!doors.hasOwnProperty(doorId)) continue;
            if (active) applyOccupied(getObj("door", doorId), doors[doorId]);
            else applyUnoccupied(getObj("door", doorId), doors[doorId]);
        }
    }

    function syncLegacyFromMechanism(mech) {
        var st = ensureState();
        if (mech.kind === "single") {
            var pdata = ensureSingleConfigData(mech.legacyId);
            pdata.doors = cloneDoorModes(mech.effects.doors);
            pdata.msgOn = mech.messages.on;
            pdata.msgOff = mech.messages.off;
            pdata.lastActive = !!mech.runtime.lastActive;
            pdata.lastOccupants = (mech.runtime.lastOccupants || []).slice();
            pdata.trap = mech.effects.trap;
            return;
        }

        var g = st.groups[mech.legacyId];
        if (!g) return;
        g.plates = mech.sources.slice();
        g.doors = cloneDoorModes(mech.effects.doors);
        g.required = (mech.rule.mode === "all") ? 0 : mech.rule.k;
        g.msgOn = mech.messages.on;
        g.msgOff = mech.messages.off;
        g.locked = !!mech.locks.mechanismLocked;
        g.lockFreeze = !!mech.locks.freezeWhenLocked;
        g.cfgLocked = !!mech.locks.configLocked;
        g.autoLock = !!mech.locks.autoLock;
        g.hasTriggered = !!mech.locks.hasTriggered;
        g.lastActive = !!mech.runtime.lastActive;
    }

    function evaluateMechanism(mech) {
        if (!mech) return;

        if (mech.kind === "single") {
            var plate = getObj("graphic", mech.sources[0]);
            if (!plate) return;

            var pdata = ensureSingleConfigData(mech.legacyId);
            var occupants = sourceOccupants(plate);
            var prevOccupants = getGraphicsByIds(mech.runtime.lastOccupants);
            var wasActive = !!mech.runtime.lastActive;
            var occ = occupants.length > 0;

            if (occ && !wasActive) postTriggerMessage(mech.messages.on);
            if (!occ && wasActive) postTriggerMessage(mech.messages.off);

            applyDoorEffects(mech.effects.doors, occ);

            if (!occ && wasActive && pdata.trap.type === "status" && pdata.trap.status.clearOnRelease && mech.rule.timing === "press") {
                var clearMarkers = parseMarkerList(pdata.trap.status.markers);
                var clearTargets = getGraphicsByIds(pdata.trap.status.lastTargets);
                for (var i = 0; i < clearTargets.length; i++) removeMarkersFromToken(clearTargets[i], clearMarkers);
                pdata.trap.status.lastTargets = [];
            }

            if (mech.effects.trap && trapFiresOnEdge(mech.rule.timing, wasActive, occ)) {
                firePlateTrap(plate, { trap: mech.effects.trap }, occ ? occupants : prevOccupants);
            }

            mech.runtime.lastActive = occ;
            mech.runtime.lastOccupants = [];
            for (i = 0; i < occupants.length; i++) mech.runtime.lastOccupants.push(occupants[i].id);
            syncLegacyFromMechanism(mech);
            return;
        }

        pruneMechanismSourcesAndDoors({
            plates: mech.sources,
            doors: mech.effects.doors
        });

        mech.pageId = inferMechanismPageId(mech.sources);

        if (mech.locks.mechanismLocked) {
            mech.runtime.lastActive = false;
            if (!mech.locks.freezeWhenLocked) applyDoorEffects(mech.effects.doors, false);
            syncLegacyFromMechanism(mech);
            return;
        }

        var pressed = countActiveMechanismSources(mech);
        var required = mech.rule.mode === "all" ? mech.sources.length : mech.rule.k;
        if (required < 1) required = mech.sources.length;
        var active = mech.sources.length > 0 && pressed >= required;

        if (active && !mech.runtime.lastActive) postTriggerMessage(mech.messages.on);
        if (!active && mech.runtime.lastActive) postTriggerMessage(mech.messages.off);
        mech.runtime.lastActive = active;

        if (active && !mech.locks.hasTriggered) {
            mech.locks.hasTriggered = true;
            applyDoorEffects(mech.effects.doors, true);
            if (mech.locks.autoLock) {
                mech.locks.mechanismLocked = true;
                mech.locks.freezeWhenLocked = true;
            }
            syncLegacyFromMechanism(mech);
            return;
        }

        applyDoorEffects(mech.effects.doors, active);
        syncLegacyFromMechanism(mech);
    }

    function evaluateSingleMechanism(plateId) {
        evaluateMechanism(syncSingleMechanismFromLegacy(plateId));
    }

    /* ---------- evaluation: groups ---------- */
    function pruneMechanismSourcesAndDoors(g) {
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

    function countPressedGroupSources(group) {
        var count = 0;
        for (var i = 0; i < group.plates.length; i++) {
            var pid = group.plates[i];
            var plate = getObj("graphic", pid);
            if (!plate) continue;
            if (isSourceOccupied(plate)) count++;
        }
        return count;
    }

    function clampRequiredSources(g) {
        var n = g.plates.length;
        var req = parseInt(g.required, 10);
        if (isNaN(req) || req < 0) req = 0; // 0 => ALL
        if (req === 0) return n;
        if (req > n) return n;
        return req;
    }

    function evaluateMultiSourceMechanism(mechanismName) {
        evaluateMechanism(syncMultiMechanismFromLegacy(mechanismName));
    }

    function evaluateAll() {
        var st = ensureState();
        syncAllMechanisms();

        for (var mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            evaluateMechanism(st.mechanisms[mechId]);
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
    function hasMechanismEditOverride(mechanismName) {
        var st = ensureState();
        var exp = st.editOverride[mechanismName];
        if (!exp) return false;
        if (Date.now() > exp) {
            delete st.editOverride[mechanismName];
            return false;
        }
        return true;
    }

    function requireMechanismConfigEditable(mechanismName) {
        var st = ensureState();
        var g = st.groups[mechanismName];
        if (!g) return true;
        if (!g.cfgLocked) return true;
        if (hasMechanismEditOverride(mechanismName)) return true;
        whisper("Group <b>" + esc(mechanismName) + "</b> is <b>CONFIG LOCKED</b>. Use <b>Override</b> to edit for 60s.");
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
    function getOrCreateLegacyMultiConfig(name) {
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

    function getSingleMechanism(plateId) {
        ensureSingleConfigData(plateId);
        return syncSingleMechanismFromLegacy(plateId);
    }

    function getGroupMechanism(name, createMissing) {
        if (createMissing) getOrCreateLegacyMultiConfig(name);
        return syncMultiMechanismFromLegacy(name);
    }

    function commitMechanism(mech) {
        if (!mech) return null;
        ensureState().mechanisms[mech.id] = mech;
        syncLegacyFromMechanism(mech);
        return mech;
    }

    function updateSingleMechanism(plateId, mutator) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return null;
        mutator(mech);
        return commitMechanism(mech);
    }

    function updateGroupMechanism(name, createMissing, mutator) {
        var mech = getGroupMechanism(name, createMissing);
        if (!mech) return null;
        mutator(mech);
        return commitMechanism(mech);
    }

    function mechanismAddSource(mech, sourceId) {
        for (var i = 0; i < mech.sources.length; i++) {
            if (mech.sources[i] === sourceId) return false;
        }
        mech.sources.push(sourceId);
        if (mech.rule.mode === "single") mech.rule.k = 1;
        return true;
    }

    function mechanismRemoveSource(mech, sourceId) {
        var out = [];
        var removed = false;

        for (var i = 0; i < mech.sources.length; i++) {
            if (mech.sources[i] === sourceId) {
                removed = true;
                continue;
            }
            out.push(mech.sources[i]);
        }

        mech.sources = out;
        if (mech.rule.mode === "all") mech.rule.k = mech.sources.length;
        else if (mech.rule.k > mech.sources.length) mech.rule.k = mech.sources.length;
        if (mech.rule.mode === "single") mech.rule.k = 1;
        return removed;
    }

    function mechanismAddDoor(mech, doorId, mode) {
        mech.effects.doors[doorId] = mode;
    }

    function mechanismRemoveDoor(mech, doorId) {
        delete mech.effects.doors[doorId];
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

    function describeSpawnTargets(trap) {
        var out = [];
        var refs = (trap && trap.spawnTargets) ? trap.spawnTargets : [];

        for (var i = 0; i < refs.length; i++) {
            var g = getObj("graphic", refs[i]);
            if (!g) continue;
            out.push((g.get("name") || "Spawn") + " …" + shortId(g.id));
        }

        return out.length ? out.join(", ") : "(none)";
    }

    function describeStatusMarkers(trap) {
        var markers = parseMarkerList(trap && trap.status ? trap.status.markers : "");
        return markers.length ? markers.join(", ") : "(none)";
    }

    /* ---------- commands: singles ---------- */
    function cmdMakePlateFromSelected(msg, plateName) {
        var sel = msg.selected || [];

        if (!sel.length) {
            whisper("Select one or more tokens, then run <code>!mech make</code>.");
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

                ensureSingleConfigData(o.id);
            }
        }

        setUIPage(msg.playerid);
        evaluateAll();
        renderUI(msg.playerid);
    }

    function cmdAddSingle(msg, mode) {
        mode = (mode || "").toLowerCase();
        if (mode !== "lock" && mode !== "secret") {
            whisper("Use <code>!mech add lock</code> or <code>!mech add secret</code>.");
            return;
        }

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

        updateSingleMechanism(plate.id, function (mech) {
            for (var d = 0; d < doors.length; d++) mechanismAddDoor(mech, doors[d].id, mode);
        });

        evaluateSingleMechanism(plate.id);
        renderUI(msg.playerid);
    }

    function cmdSimOpen(plateId) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return;
        for (var doorId in mech.effects.doors) {
            if (!mech.effects.doors.hasOwnProperty(doorId)) continue;
            applyOccupied(getObj("door", doorId), mech.effects.doors[doorId]);
        }
    }

    function cmdSimClose(plateId) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return;
        for (var doorId in mech.effects.doors) {
            if (!mech.effects.doors.hasOwnProperty(doorId)) continue;
            applyUnoccupied(getObj("door", doorId), mech.effects.doors[doorId]);
        }
    }

    function cmdRemoveSingleMechanism(plateId) {
        var st = ensureState();
        unlockTokensForSource(plateId);
        delete st.plates[plateId];
        delete st.mechanisms[singleMechanismId(plateId)];

        // Also remove it from any groups
        for (var gname in st.groups) {
            if (!st.groups.hasOwnProperty(gname)) continue;
            updateGroupMechanism(gname, false, function (mech) {
                mechanismRemoveSource(mech, plateId);
            });
        }
    }

    function cmdSetSingleMessageOn(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.messages.on = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " trigger message set.");
    }

    function cmdSetSingleMessageOff(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.messages.off = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " release message set.");
    }

    function cmdTrapToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.enabled = !mech.effects.trap.enabled;
            if (mech.effects.trap.enabled && mech.effects.trap.type === "none") mech.effects.trap.type = "alarm";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " trap is now " + (mech.effects.trap.enabled ? "<b>ENABLED</b>" : "<b>DISABLED</b>") + ".");
    }

    function cmdTrapType(plateId, type) {
        type = String(type || "").toLowerCase();

        if (!TRAP_TYPES[type]) {
            whisper("Trap type must be one of: <code>alarm</code>, <code>damage</code>, <code>teleport</code>, <code>reveal</code>, <code>save</code>, <code>status</code>, <code>spawn</code>, <code>none</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.type = type;
            mech.effects.trap.enabled = (type !== "none");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " trap type set to <b>" + esc(trapTypeLabel(type).toUpperCase()) + "</b>.");
    }

    function cmdTrapTrigger(plateId, trigger) {
        trigger = String(trigger || "").toLowerCase();

        if (!TRAP_TRIGGERS[trigger]) {
            whisper("Trap trigger must be <code>press</code>, <code>release</code>, or <code>both</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.rule.timing = trigger;
            mech.effects.trap.trigger = trigger;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " trap trigger set to <b>" + esc(trapTriggerLabel(trigger).toUpperCase()) + "</b>.");
    }

    function cmdTrapMessage(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.message = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " trap message set.");
    }

    function cmdTrapDamage(plateId, dmgExpr) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.damage = String(dmgExpr || "").trim() || "1d6";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " damage roll set to <b>" + esc(mech.effects.trap.damage) + "</b>.");
    }

    function cmdTrapSaveLabel(plateId, label) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.label = String(label || "").replace(/^\s+|\s+$/g, "").toUpperCase() || "DEX";
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save label set to <b>" + esc(mech.effects.trap.save.label) + "</b>.");
    }

    function cmdTrapSaveDc(plateId, dc) {
        dc = parseInt(dc, 10);
        if (isNaN(dc) || dc < 1) dc = 12;
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.dc = dc;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save DC set to <b>" + esc(String(dc)) + "</b>.");
    }

    function cmdTrapSaveSuccessMsg(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.successMsg = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save success text set.");
    }

    function cmdTrapSaveFailMsg(plateId, msgText) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.failMsg = String(msgText || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save fail text set.");
    }

    function cmdTrapSaveSuccessMode(plateId, mode) {
        mode = String(mode || "").toLowerCase();
        if (mode !== "half" && mode !== "none") {
            whisper("Save success must be <code>half</code> or <code>none</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.successMode = mode;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save success set to <b>" + esc(mode.toUpperCase()) + "</b>.");
    }

    function cmdTrapSaveDamageType(plateId, dmgType) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.damageType = String(dmgType || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save damage type set.");
    }

    function cmdTrapSaveFailDamage(plateId, dmgExpr) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.save.failDamage = String(dmgExpr || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " save fail damage set.");
    }

    function cmdTrapStatusMarkers(plateId, markers) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.status.markers = String(markers || "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " status markers set.");
    }

    function cmdTrapStatusClearToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.status.clearOnRelease = !mech.effects.trap.status.clearOnRelease;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " clear-on-release is now " + (mech.effects.trap.status.clearOnRelease ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdTrapSetTeleport(msg, plateId) {
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
            whisper("Select one destination token/graphic, then run <code>!mech trapsetteleport " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.teleport = {
                pageId: marker.get("_pageid"),
                left: marker.get("left"),
                top: marker.get("top"),
                name: marker.get("name") || ("Marker …" + shortId(marker.id))
            };
        });
        whisper("Teleport destination saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapClearTeleport(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.teleport = defaultTrapConfig().teleport;
        });
        whisper("Teleport destination cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapSetReveal(msg, plateId) {
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
            whisper("Select one or more hidden graphics or secret doors, then run <code>!mech trapsetreveal " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.revealTargets = refs;
        });
        whisper("Reveal targets saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapClearReveal(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.revealTargets = [];
        });
        whisper("Reveal targets cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapSetSpawn(msg, plateId) {
        var sel = msg.selected || [];
        var ids = [];

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.id === plateId) continue;
            if (o.get("_type") === "graphic") ids.push(o.id);
        }

        if (!ids.length) {
            whisper("Select one or more GM-layer spawn tokens, then run <code>!mech trapsetspawn " + esc(plateId) + "</code>.");
            return;
        }

        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.spawnTargets = ids;
        });
        whisper("Spawn targets saved for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapClearSpawn(plateId) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.spawnTargets = [];
        });
        whisper("Spawn targets cleared for trigger …" + esc(shortId(plateId)) + ".");
    }

    function cmdTrapLockToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.effects.lockToken = !mech.effects.trap.effects.lockToken;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " lock-token effect is now " + (mech.effects.trap.effects.lockToken ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdTrapLockMarker(plateId, marker) {
        updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.effects.lockMarker = String(marker || "").replace(/^\s+|\s+$/g, "");
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " lock marker updated.");
    }

    function cmdTrapRevealToggle(plateId) {
        var mech = updateSingleMechanism(plateId, function (mech) {
            mech.effects.trap.effects.revealAlso = !mech.effects.trap.effects.revealAlso;
        });
        whisper("Trigger …" + esc(shortId(plateId)) + " reveal effect is now " + (mech.effects.trap.effects.revealAlso ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdTrapUnlock(plateId) {
        var count = unlockTokensForSource(plateId);
        whisper("Unlocked <b>" + esc(String(count)) + "</b> token(s) for trigger …" + esc(shortId(plateId)) + ".");
    }

    function renderTrapUI(playerid, plateId) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return whisper("Trigger not found.");

        var plate = getObj("graphic", plateId);
        if (!plate) return whisper("Trigger not found.");

        var trap = mech.effects.trap;
        var occ = isSourceOccupied(plate);
        var name = mechanismDisplayName(mech);
        var enabled = trap.enabled && trap.type !== "none";
        var triggerHint = enabled ? (trapTypeLabel(trap.type) + " / " + trapTriggerLabel(trap.trigger)) : "Disabled";

        var html = "";
        html += '<div style="border:2px solid #111;border-radius:12px;overflow:hidden;max-width:760px;font-family:Arial,sans-serif;">';
        html += '<div style="background:#000;color:#fff;padding:10px 12px;">';
        html += '<div style="font-weight:900;font-size:20px;">Mechanism Configuration</div>';
        html += '<div style="color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;">' + esc(name) + " • " + esc(triggerHint) + "</div>";
        html += "</div>";
        html += '<div style="background:#fff;padding:10px;">';

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += badge(occ ? "OCCUPIED" : "CLEAR", occ);
        html += enabled ? badge("TRAP ENABLED", false) : badge("TRAP DISABLED", false);
        html += '<div style="margin-top:8px;">';
        html += iconBtn("↩️", "!mech ui", "Back to mechanism list");
        html += iconBtn("💣", "!mech traptoggle " + plateId, enabled ? "Disable trap" : "Enable trap");
        html += iconBtn("🔄", "!mech trapui " + plateId, "Refresh trap configuration");
        html += "</div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Trap Type</div>';
        html += mini("Alarm", "!mech traptype " + plateId + " alarm", "Narration or warning trap");
        html += mini("Damage", "!mech traptype " + plateId + " damage", "Damage trap");
        html += mini("Save", "!mech traptype " + plateId + " save", "Save/check prompt trap");
        html += mini("Status", "!mech traptype " + plateId + " status", "Apply status markers");
        html += mini("Spawn", "!mech traptype " + plateId + " spawn", "Reveal selected spawn tokens");
        html += mini("Teleport", "!mech traptype " + plateId + " teleport", "Teleport occupants");
        html += mini("Reveal", "!mech traptype " + plateId + " reveal", "Reveal hidden targets");
        html += mini("Disable", "!mech traptype " + plateId + " none", "Disable trap without removing plate");
        html += '<div style="margin-top:8px;font-weight:900;">Current type: <span style="color:#333;">' + esc(trapTypeLabel(trap.type)) + "</span></div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Trigger</div>';
        html += mini("Press", "!mech traptrigger " + plateId + " press", "Fire when the plate is pressed");
        html += mini("Release", "!mech traptrigger " + plateId + " release", "Fire when the plate is released");
        html += mini("Both", "!mech traptrigger " + plateId + " both", "Fire on press and release");
        html += '<div style="margin-top:8px;font-weight:900;">Current trigger: <span style="color:#333;">' + esc(trapTriggerLabel(trap.trigger)) + "</span></div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Messaging</div>';
        html += mini("Set message", "!mech trapmsg " + plateId + " ?{Trap message|}", "Optional narration when the trap fires");
        html += '<div style="margin-top:8px;font-weight:900;">Message: <span style="color:#333;">' + esc(String(trap.message || "").trim() || "(none)") + "</span></div>";
        html += "</div>";

        if (trap.type === "damage") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Damage Settings</div>';
            html += mini("Set damage", "!mech trapdamage " + plateId + " ?{Damage roll|1d6}", "Roll expression for the damage trap");
            html += '<div style="margin-top:8px;font-weight:900;">Damage: <span style="color:#333;">' + esc(trap.damage) + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "save") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Save Settings</div>';
            html += mini("Set save label", "!mech trapsavelabel " + plateId + " ?{Save label|DEX}", "Ability/check label");
            html += mini("Set DC", "!mech trapsavedc " + plateId + " ?{Save DC|12}", "Difficulty class");
            html += mini("Set success text", "!mech trapsavesuccessmsg " + plateId + " ?{Success text|}", "Text shown on success");
            html += mini("Set fail text", "!mech trapsavefailmsg " + plateId + " ?{Fail text|}", "Text shown on fail");
            html += mini("Success: HALF", "!mech trapsavesuccess " + plateId + " half", "Success takes half damage");
            html += mini("Success: NONE", "!mech trapsavesuccess " + plateId + " none", "Success takes no damage");
            html += mini("Set damage type", "!mech trapsavedmgtype " + plateId + " ?{Damage type|piercing|slashing|bludgeoning|acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder}", "Associated damage type");
            html += mini("Set fail damage", "!mech trapsavefaildmg " + plateId + " ?{Fail damage|1d6}", "Optional fail damage");
            html += '<div style="margin-top:8px;font-weight:900;">Save: <span style="color:#333;">' + esc(String(trap.save.label).toUpperCase()) + " DC " + esc(String(trap.save.dc)) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Success: <span style="color:#333;">' + esc(String(trap.save.successMsg || "").trim() || "(none)") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Success result: <span style="color:#333;">' + esc(String(trap.save.successMode || "none").toUpperCase()) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Damage type: <span style="color:#333;">' + esc(String(trap.save.damageType || "").trim() || "(none)") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Fail: <span style="color:#333;">' + esc(String(trap.save.failMsg || "").trim() || "(none)") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Fail damage: <span style="color:#333;">' + esc(String(trap.save.failDamage || "").trim() || "(none)") + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "status") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Status Settings</div>';
            html += mini("Set markers", "!mech trapstatusmarkers " + plateId + " ?{Markers (comma-separated)|cobweb}", "Token status markers to apply");
            html += mini(trap.status.clearOnRelease ? "Clear on release: ON" : "Clear on release: OFF", "!mech trapstatusclear " + plateId, "Toggle removal when the plate releases");
            html += '<div style="margin-top:8px;font-weight:900;">Markers: <span style="color:#333;">' + esc(describeStatusMarkers(trap)) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Clear on release: <span style="color:#333;">' + esc(trap.status.clearOnRelease ? "ON (press-trigger only)" : "OFF") + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "teleport") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Teleport Settings</div>';
            html += mini("Set destination from selection", "!mech trapsetteleport " + plateId, "Select one marker graphic, then click");
            html += mini("Clear destination", "!mech trapclearteleport " + plateId, "Remove teleport destination");
            html += '<div style="margin-top:8px;font-weight:900;">Destination: <span style="color:#333;">' + esc(describeTeleportDestination(trap)) + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "reveal") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Reveal Settings</div>';
            html += mini("Set reveal targets from selection", "!mech trapsetreveal " + plateId, "Select graphics or doors to reveal, then click");
            html += mini("Clear reveal targets", "!mech trapclearreveal " + plateId, "Remove reveal target list");
            html += '<div style="margin-top:8px;font-weight:900;">Targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
            html += "</div>";
        }

        if (trap.type === "spawn") {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Spawn Settings</div>';
            html += mini("Set spawn targets from selection", "!mech trapsetspawn " + plateId, "Select one or more GM-layer graphics to reveal");
            html += mini("Clear spawn targets", "!mech trapclearspawn " + plateId, "Remove spawn target list");
            html += '<div style="margin-top:8px;font-weight:900;">Targets: <span style="color:#333;">' + esc(describeSpawnTargets(trap)) + "</span></div>";
            html += "</div>";
        }

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Extra Effects</div>';
        if (trap.type !== "reveal") html += mini(trap.effects.revealAlso ? "Reveal targets: ON" : "Reveal targets: OFF", "!mech traprevealtoggle " + plateId, "Toggle revealing configured targets when this trap triggers");
        html += mini("Set reveal targets", "!mech trapsetreveal " + plateId, "Select graphics or doors to reveal, then click");
        html += mini("Clear reveal targets", "!mech trapclearreveal " + plateId, "Remove reveal target list");
        html += mini(trap.effects.lockToken ? "Lock token: ON" : "Lock token: OFF", "!mech traplocktoggle " + plateId, "Toggle immobilizing tokens hit by this trap");
        html += mini("Set lock marker", "!mech traplockmarker " + plateId + " ?{Lock marker|fishing-net}", "Marker added to locked tokens");
        html += mini("Unlock tokens", "!mech trapunlock " + plateId, "Clear tokens currently locked by this plate");
        if (trap.type !== "reveal") html += '<div style="margin-top:8px;font-weight:900;">Reveal effect: <span style="color:#333;">' + esc(trap.effects.revealAlso ? "ON" : "OFF") + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Reveal targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
        html += '<div style="margin-top:8px;font-weight:900;">Lock effect: <span style="color:#333;">' + esc(trap.effects.lockToken ? "ON" : "OFF") + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Lock marker: <span style="color:#333;">' + esc(String(trap.effects.lockMarker || "").trim() || "(none)") + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Locked tokens: <span style="color:#333;">' + esc(String(lockedCountForSource(plateId))) + "</span></div>";
        html += "</div>";

        html += "</div></div>";
        whisper(html);
    }

    /* ---------- commands: groups ---------- */
    function cmdCreateMultiMechanismFromSelected(msg, name, required) {
        if (!name) { whisper("Usage: <code>!mech groupmake NAME [K]</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        required = parseInt(required, 10);
        if (isNaN(required) || required < 0) required = 0;
        var mech = getGroupMechanism(name, true);
        mech.rule.mode = required === 0 ? "all" : "kofn";
        mech.rule.k = required === 0 ? mech.sources.length : required;

        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                ensureSingleConfigData(o.id);
                if (mechanismAddSource(mech, o.id)) added++;
            }
        }

        if (mech.rule.mode === "all") mech.rule.k = mech.sources.length;
        commitMechanism(mech);
        whisper("Group <b>" + esc(name) + "</b> updated. Added <b>" + esc(String(added)) + "</b> plate(s).");
    }

    function cmdAddSourcesToMultiMechanism(msg, name) {
        if (!name) { whisper("Usage: <code>!mech groupaddplates NAME</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        var mech = getGroupMechanism(name, true);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                ensureSingleConfigData(o.id);
                if (mechanismAddSource(mech, o.id)) added++;
            }
        }

        if (mech.rule.mode === "all") mech.rule.k = mech.sources.length;
        commitMechanism(mech);
        whisper("Added <b>" + esc(String(added)) + "</b> plate(s) to group <b>" + esc(name) + "</b>.");
    }

    function cmdAddDoorsToMultiMechanism(msg, name, mode) {
        if (!name) { whisper("Usage: <code>!mech groupadddoors NAME lock|secret</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        mode = (mode || "").toLowerCase();
        if (mode !== "lock" && mode !== "secret") {
            whisper("Usage: select Door object(s), then <code>!mech groupadddoors " + esc(name) + " lock</code> or <code>... secret</code>.");
            return;
        }

        var mech = getGroupMechanism(name, true);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "door") {
                mechanismAddDoor(mech, o.id, mode);
                added++;
            }
        }

        commitMechanism(mech);
        whisper("Added <b>" + esc(String(added)) + "</b> door(s) to group <b>" + esc(name) + "</b> as <b>" + esc(mode.toUpperCase()) + "</b>.");
    }

    function cmdSetMultiMechanismRequireAll(name) {
        if (!requireMechanismConfigEditable(name)) return;
        updateGroupMechanism(name, true, function (mech) {
            mech.rule.mode = "all";
            mech.rule.k = mech.sources.length;
        });
        whisper("Group <b>" + esc(name) + "</b> now requires <b>ALL</b> plates.");
    }

    function cmdSetMultiMechanismRequiredCount(name, k) {
        if (!requireMechanismConfigEditable(name)) return;
        k = parseInt(k, 10);
        if (isNaN(k) || k < 1) { whisper("K must be a number >= 1."); return; }
        updateGroupMechanism(name, true, function (mech) {
            mech.rule.mode = "kofn";
            mech.rule.k = k;
        });
        whisper("Group <b>" + esc(name) + "</b> now requires <b>" + esc(String(k)) + "</b> plate(s).");
    }

    // Trigger lock toggle
    function cmdToggleMechanismLock(name) {
        var mech = updateGroupMechanism(name, false, function (mech) {
            if (mech.locks.mechanismLocked && mech.locks.freezeWhenLocked) mech.locks.freezeWhenLocked = false;
            mech.locks.mechanismLocked = !mech.locks.mechanismLocked;
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        whisper("Group <b>" + esc(name) + "</b> is now " + (mech.locks.mechanismLocked ? "<b>LOCKED</b> (mechanism disabled)" : "<b>UNLOCKED</b>") + ".");
    }

    // Config lock toggle
    function cmdToggleMechanismConfigLock(name) {
        var st = ensureState();
        var mech = updateGroupMechanism(name, false, function (mech) {
            mech.locks.configLocked = !mech.locks.configLocked;
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        if (mech.locks.configLocked) delete st.editOverride[name];
        whisper("Group <b>" + esc(name) + "</b> config is now " + (mech.locks.configLocked ? "<b>CONFIG LOCKED</b>" : "<b>CONFIG UNLOCKED</b>") + ".");
    }

    // GM override for config lock (60s)
    function cmdEnableMechanismOverride(name) {
        var st = ensureState();
        var g = st.groups[name];
        if (!g) return whisper("Group not found: " + esc(name));

        st.editOverride[name] = Date.now() + OVERRIDE_MS;
        whisper("Override enabled for group <b>" + esc(name) + "</b> for <b>60 seconds</b>.");
    }

    // Auto-lock toggle
    function cmdToggleMechanismAutoLock(name) {
        if (!requireMechanismConfigEditable(name)) return;

        var mech = updateGroupMechanism(name, false, function (mech) {
            mech.locks.autoLock = !mech.locks.autoLock;
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        whisper("Group <b>" + esc(name) + "</b> Auto-lock after first trigger is now " + (mech.locks.autoLock ? "<b>ON</b>" : "<b>OFF</b>") + ".");
    }

    function cmdResetMechanismTriggerState(name) {
        if (!requireMechanismConfigEditable(name)) return;
        var mech = updateGroupMechanism(name, false, function (mech) {
            mech.locks.hasTriggered = false;
            if (mech.locks.mechanismLocked && mech.locks.freezeWhenLocked) {
                mech.locks.mechanismLocked = false;
                mech.locks.freezeWhenLocked = false;
            }
        });
        if (!mech) return whisper("Group not found: " + esc(name));
        whisper("Group <b>" + esc(name) + "</b> trigger state reset (hasTriggered = false).");
    }

    function cmdRemoveMultiMechanism(name) {
        var st = ensureState();
        delete st.groups[name];
        delete st.mechanisms[multiMechanismId(name)];
        delete st.editOverride[name];
        whisper("Removed group <b>" + esc(name) + "</b>.");
    }

    function cmdRemoveSourceFromMultiMechanism(name, plateId) {
        if (!requireMechanismConfigEditable(name)) return;
        var mech = updateGroupMechanism(name, false, function (mech) {
            mechanismRemoveSource(mech, plateId);
        });
        if (!mech) return;
        whisper("Removed plate …" + esc(shortId(plateId)) + " from group <b>" + esc(name) + "</b>.");
    }

    function cmdRemoveDoorFromMultiMechanism(name, doorId) {
        if (!requireMechanismConfigEditable(name)) return;
        var mech = updateGroupMechanism(name, false, function (mech) {
            mechanismRemoveDoor(mech, doorId);
        });
        if (!mech) return;
        whisper("Detached door …" + esc(shortId(doorId)) + " from group <b>" + esc(name) + "</b>.");
    }

    function cmdSetMultiMechanismMessageOn(name, msgText) {
        if (!requireMechanismConfigEditable(name)) return;
        updateGroupMechanism(name, true, function (mech) {
            mech.messages.on = String(msgText || "");
        });
        whisper("Group <b>" + esc(name) + "</b> trigger message set.");
    }

    function cmdSetMultiMechanismMessageOff(name, msgText) {
        if (!requireMechanismConfigEditable(name)) return;
        updateGroupMechanism(name, true, function (mech) {
            mech.messages.off = String(msgText || "");
        });
        whisper("Group <b>" + esc(name) + "</b> release message set.");
    }

    function mechanismDisplayName(mech) {
        return mech.name || ("Mechanism …" + shortId(mech.id));
    }

    function mechanismVisibleOnPage(mech, pageId) {
        if (!mech) return false;
        if (mech.pageId && mech.pageId === pageId) return true;

        for (var i = 0; i < mech.sources.length; i++) {
            var source = getObj("graphic", mech.sources[i]);
            if (source && source.get("_pageid") === pageId) return true;
        }
        return false;
    }

    function mechanismRequiredCount(mech) {
        if (!mech) return 0;
        if (mech.rule.mode === "all") return mech.sources.length;
        if (mech.rule.mode === "single") return 1;
        return mech.rule.k;
    }

    function mechanismIsActive(mech) {
        if (!mech) return false;
        if (mech.kind === "single") {
            var plate = getObj("graphic", mech.sources[0]);
            return !!plate && isSourceOccupied(plate);
        }
        if (mech.locks.mechanismLocked) return false;
        var required = mechanismRequiredCount(mech);
        return mech.sources.length > 0 && countActiveMechanismSources(mech) >= required;
    }

    function mechanismRuleSummary(mech) {
        if (!mech) return "";
        if (mech.kind === "single") {
            var timing = mech.effects.trap ? trapTriggerLabel(mech.rule.timing) : "Occupancy";
            return "1 source / " + timing;
        }

        var required = mechanismRequiredCount(mech);
        return required + " of " + mech.sources.length + " / " + trapTriggerLabel(mech.rule.timing);
    }

    function mechanismEffectSummary(mech) {
        var parts = [];
        var doorCount = Object.keys(mech.effects.doors || {}).length;
        var trap = mech.effects.trap;
        var trapEnabled = trap && trap.enabled && trap.type !== "none";

        if (doorCount) parts.push(doorCount + " door" + (doorCount === 1 ? "" : "s"));
        if (trapEnabled) parts.push(trapTypeLabel(trap.type));

        return parts.length ? parts.join(" + ") : "(no effects)";
    }

    function sortMechanismsForUi(a, b) {
        if (a.kind !== b.kind) return a.kind === "single" ? -1 : 1;
        var an = mechanismDisplayName(a).toLowerCase();
        var bn = mechanismDisplayName(b).toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return 1;
        return 0;
    }

    /* ---------- UI rendering ---------- */
    function renderUI(playerid) {
        var st = ensureState();
        var pageId = getUIPage(playerid);
        var pageName = getUIPageName(pageId);
        var suggested = safeGroupNameFromPage(pageName);
        var mechs = [];
        var mechId;

        syncAllMechanisms();
        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            if (!mechanismVisibleOnPage(st.mechanisms[mechId], pageId)) continue;
            mechs.push(st.mechanisms[mechId]);
        }
        mechs.sort(sortMechanismsForUi);

        var html = "";
        html += '<div style="border:2px solid #111;border-radius:12px;overflow:hidden;max-width:860px;font-family:Arial,sans-serif;">';

        // header
        html += '<div style="background:#000;color:#fff;padding:10px 12px;">';
        html += '<div style="font-weight:900;font-size:20px;">Mechanism List</div>';
        html += '<div style="color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;">UI Page: ' + esc(pageName) + ' (…' + esc(shortId(pageId)) + ')</div>';
        html += "</div>";

        // body
        html += '<div style="background:#fff;padding:10px;">';

        // global controls
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Controls</div>';
        html += iconBtn("🧱", "!mech make ?{Plate name|Pressure_Plate}", "Make Plate from selected (moves to GM layer)");
        html += iconBtn("🧭", "!mech setpage", "Use Current Page (Set)");
        html += iconBtn("🔄", "!mech ui", "Refresh UI");
        html += iconBtn("✅", "!mech check", "Force Check all plates/groups");
        html += "</div>";

        // group tools
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Multi-Source Tools</div>';
        html += '<div style="color:#333;font-weight:900;margin-bottom:8px;">Suggested name: <span style="font-family:monospace;">' + esc(suggested) + "</span></div>";

        html += mini("Create group from selected plates", "!mech groupmake ?{Group Name (no spaces)|" + esc(suggested) + "} ?{Required K (0=ALL)|0}", "Create/Update group and add selected plates");
        html += mini("Add selected plates to group", "!mech groupaddplates ?{Group Name (no spaces)|" + esc(suggested) + "}", "Add selected plates to named group");
        html += mini("Add selected doors LOCK", "!mech groupadddoors ?{Group Name (no spaces)|" + esc(suggested) + "} lock", "Bind selected door(s) to group as LOCK");
        html += mini("Add selected doors SECRET", "!mech groupadddoors ?{Group Name (no spaces)|" + esc(suggested) + "} secret", "Bind selected door(s) to group as SECRET");
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;margin-bottom:12px;">';
        html += '<div style="padding:8px 10px;border-bottom:2px solid #111;background:#f3f4f6;">';
        html += '<span style="font-weight:900;font-size:18px;">Mechanisms</span>';
        html += '<span style="color:#444;font-weight:900;margin-left:10px;">(single-source and multi-source)</span>';
        html += "</div>";

        if (!mechs.length) {
            html += '<div style="padding:10px;color:#666;font-weight:900;">(No mechanisms on this page)</div>';
        }

        for (var m = 0; m < mechs.length; m++) {
            var mech = mechs[m];
            var active = mechanismIsActive(mech);
            var required = mechanismRequiredCount(mech);
            var pressed = countActiveMechanismSources(mech);
            var trap = mech.effects.trap || defaultTrapConfig();
            var trapEnabled = trap.enabled && trap.type !== "none";
            var lockIcon = mech.locks.mechanismLocked ? "🔒" : "🔓";
            var cfgIcon = mech.locks.configLocked ? "🧱" : "✏️";
            var autoIcon = mech.locks.autoLock ? "⭐" : "☆";
            var overrideActive = mech.kind === "group" && hasMechanismEditOverride(mech.legacyId);
            var editBlocked = mech.kind === "group" && mech.locks.configLocked && !overrideActive;
            var lockText = mech.locks.mechanismLocked ? (mech.locks.freezeWhenLocked ? "FROZEN" : "LOCKED") : "UNLOCKED";

            var name = mechanismDisplayName(mech);
            html += '<div style="border-top:2px solid #111;">';
            html += '<div style="padding:8px 10px;border-bottom:2px solid #111;">';
            html += '<span style="font-weight:900;font-size:18px;">' + esc(name) + "</span>" +
                badge(active ? "ACTIVE" : "INACTIVE", active);
            html += badge(mech.kind === "single" ? "SINGLE" : "MULTI", false);
            if (trapEnabled) html += badge("TRAP", false);
            if (mech.kind === "group" && mech.locks.mechanismLocked) html += badge(lockText, false);
            if (mech.kind === "group" && mech.locks.configLocked) html += badge("CONFIG", false);
            if (overrideActive) html += badge("OVERRIDE", true);
            if (mech.kind === "group" && mech.locks.autoLock) html += badge("AUTOLOCK", true);
            html += "</div>";

            html += '<div style="padding:8px 10px;">';
            if (mech.kind === "single") {
                var plateId = mech.legacyId;
                html += iconBtn("🔍", "!mech ping " + plateId, "Ping trigger");
                html += iconBtn("✅", "!mech checkplate " + plateId, "Check mechanism");
                html += iconBtn("⬆️", "!mech simopen " + plateId, "Force open (simulate triggered)");
                html += iconBtn("⬇️", "!mech simclose " + plateId, "Force close (simulate released)");
                html += iconBtn("🗑️", "!mech removeplate " + plateId, "Remove trigger");
                html += iconBtn("🔗", "!mech add lock", "Bind selected Door(s) to the selected trigger as LOCK");
                html += iconBtn("👁️", "!mech add secret", "Bind selected Door(s) to the selected trigger as SECRET");
                html += iconBtn("💣", "!mech trapui " + plateId, trapEnabled ? "Open mechanism configuration" : "Add trap/effects to this trigger");
                html += iconBtn("📣", "!mech platemsgon " + plateId + " ?{Trigger message (plate pressed)|}", "Set trigger message (press)");
                html += iconBtn("🔕", "!mech platemsgoff " + plateId + " ?{Release message (plate released)|}", "Set release message (release)");
            } else {
                var gname = mech.legacyId;
                html += iconBtn(lockIcon, "!mech grouplock " + gname, mech.locks.mechanismLocked ? "Unlock mechanism" : "Lock mechanism (disable)");
                html += iconBtn("✅", "!mech groupcheck " + gname, "Check mechanism");
                html += iconBtn(cfgIcon, "!mech groupcfglock " + gname, mech.locks.configLocked ? "Unlock config (allow edits)" : "Lock config (prevent edits)");
                if (mech.locks.configLocked) html += iconBtn("⚡", "!mech groupoverride " + gname, "Override config lock for 60s");
                else html += iconBtnDisabled("⚡", "Override only needed when config locked");
                if (editBlocked) html += iconBtnDisabled(autoIcon, "Config locked (use Override to change auto-lock)");
                else html += iconBtn(autoIcon, "!mech groupautolock " + gname, mech.locks.autoLock ? "Auto-lock after first trigger: ON (click to disable)" : "Auto-lock after first trigger: OFF (click to enable)");
                if (editBlocked) html += iconBtnDisabled("🔁", "Config locked (use Override to reset trigger)");
                else html += iconBtn("🔁", "!mech groupreset " + gname, "Reset hasTriggered (and unfreeze if auto-locked)");
                if (editBlocked) {
                    html += iconBtnDisabled("➕", "Config locked");
                    html += iconBtnDisabled("🔗", "Config locked");
                    html += iconBtnDisabled("👁️", "Config locked");
                    html += iconBtnDisabled("🗑️", "Config locked");
                    html += iconBtnDisabled("📣", "Config locked");
                    html += iconBtnDisabled("🔕", "Config locked");
                } else {
                    html += iconBtn("➕", "!mech groupaddplates " + gname, "Add selected triggers to this mechanism");
                    html += iconBtn("🔗", "!mech groupadddoors " + gname + " lock", "Add selected doors as LOCK");
                    html += iconBtn("👁️", "!mech groupadddoors " + gname + " secret", "Add selected doors as SECRET");
                    html += iconBtn("🗑️", "!mech groupremove " + gname, "Remove mechanism");
                    html += iconBtn("📣", "!mech groupmsgon " + gname + " ?{Trigger message (group active)|}", "Set trigger message");
                    html += iconBtn("🔕", "!mech groupmsgoff " + gname + " ?{Release message (group inactive)|}", "Set release message");
                }
            }

            html += '<div style="margin-top:6px;font-weight:900;">rule: <span style="font-weight:900;color:#333;">' + esc(mechanismRuleSummary(mech)) + "</span></div>";
            html += '<div style="margin-top:6px;font-weight:900;">effects: <span style="font-weight:900;color:#333;">' + esc(mechanismEffectSummary(mech)) + "</span></div>";

            if (mech.kind === "group") {
                html += '<div style="margin-top:6px;font-weight:900;">status: <span style="font-weight:900;color:#333;">' + esc(String(pressed)) + "/" + esc(String(required)) + " pressed</span></div>";
            }

            if (String(mech.messages.on || "").trim()) {
                html += '<div style="margin-top:6px;color:#111;font-weight:900;">On: <span style="font-weight:700;">' + esc(mech.messages.on) + "</span></div>";
            }
            if (String(mech.messages.off || "").trim()) {
                html += '<div style="margin-top:4px;color:#111;font-weight:900;">Off: <span style="font-weight:700;">' + esc(mech.messages.off) + "</span></div>";
            }

            if (mech.kind === "group") {
                html += "<div style='margin-top:6px;'></div>";
                if (editBlocked) {
                    html += miniDisabled("Require ALL", "Config locked");
                    html += miniDisabled("Set K…", "Config locked");
                } else {
                    html += mini("Require ALL", "!mech groupsetall " + mech.legacyId, "Require all sources");
                    html += mini("Set K…", "!mech groupsetk " + mech.legacyId + " ?{Require how many plates?|2}", "Set required K (K-of-N)");
                }
            }

            html += '<div style="margin-top:10px;font-weight:900;">Sources</div>';
            var anySourceListed = false;
            for (var s = 0; s < mech.sources.length; s++) {
                var src = getObj("graphic", mech.sources[s]);
                if (!src || src.get("_pageid") !== pageId) continue;
                anySourceListed = true;
                var srcOcc = isSourceOccupied(src);
                var srcName = src.get("name") || ("Trigger …" + shortId(src.id));
                html += '<div style="margin-left:12px;margin-top:6px;font-weight:900;">' +
                    esc(srcName) + badge(srcOcc ? "DOWN" : "UP", srcOcc) +
                    mini("Ping", "!mech ping " + src.id, "Ping this trigger");
                if (mech.kind === "group") {
                    if (editBlocked) html += miniDisabled("Remove", "Config locked");
                    else html += mini("Remove", "!mech groupdelplate " + mech.legacyId + " " + src.id, "Remove this trigger from the mechanism");
                }
                html += "</div>";
            }
            if (!anySourceListed) {
                html += '<div style="margin-left:12px;margin-top:6px;color:#666;font-weight:900;">(No sources on this page)</div>';
            }

            html += '<div style="margin-top:12px;font-weight:900;">Doors</div>';
            var hasDoors = false;
            for (var did3 in mech.effects.doors) {
                if (!mech.effects.doors.hasOwnProperty(did3)) continue;
                hasDoors = true;
                var d3 = getObj("door", did3);
                if (!d3) continue;

                html += '<div style="margin-left:12px;margin-top:6px;font-weight:900;">' +
                    esc(String(mech.effects.doors[did3]).toUpperCase()) + " door …" + esc(shortId(did3)) +
                    ' <span style="color:#666;">(' + esc(doorBits(d3)) + ")</span> ";

                if (mech.kind === "group") {
                    if (editBlocked) html += miniDisabled("Detach", "Config locked");
                    else html += mini("Detach", "!mech groupdeldor " + mech.legacyId + " " + did3, "Detach this door from group");
                }

                html += "</div>";
            }
            if (!hasDoors) {
                html += '<div style="margin-left:12px;margin-top:6px;color:#666;font-weight:900;">(No doors bound)</div>';
            }

            html += "</div></div>";
        }

        html += "</div>";
        html += "</div></div>"; // body + shell

        whisper(html);
    }

    function showCommandHelp() {
        whisper(
            "Commands:<br>" +
            "<code>!mech ui</code>, <code>!mech setpage</code>, <code>!mech make NAME</code>, <code>!mech add lock|secret</code>, <code>!mech check</code>, <code>!mech ping PLATEID</code><br>" +
            "Trap UI:<br><code>!mech trapui PLATEID</code>, <code>!mech traptoggle PLATEID</code>, <code>!mech traptype PLATEID alarm|damage|teleport|reveal|save|status|spawn|none</code><br>" +
            "<code>!mech traptrigger PLATEID press|release|both</code>, <code>!mech trapmsg PLATEID ...</code>, <code>!mech trapdamage PLATEID XdY</code><br>" +
            "<code>!mech trapsavelabel PLATEID LABEL</code>, <code>!mech trapsavedc PLATEID DC</code>, <code>!mech trapsavesuccessmsg PLATEID ...</code>, <code>!mech trapsavefailmsg PLATEID ...</code><br>" +
            "<code>!mech trapsavesuccess PLATEID half|none</code>, <code>!mech trapsavedmgtype PLATEID TYPE</code>, <code>!mech trapsavefaildmg PLATEID XdY</code>, <code>!mech trapstatusmarkers PLATEID marker1,marker2</code>, <code>!mech trapstatusclear PLATEID</code><br>" +
            "<code>!mech trapsetteleport PLATEID</code>, <code>!mech trapclearteleport PLATEID</code>, <code>!mech trapsetreveal PLATEID</code>, <code>!mech trapclearreveal PLATEID</code>, <code>!mech traprevealtoggle PLATEID</code><br>" +
            "<code>!mech trapsetspawn PLATEID</code>, <code>!mech trapclearspawn PLATEID</code>, <code>!mech traplocktoggle PLATEID</code>, <code>!mech traplockmarker PLATEID MARKER</code>, <code>!mech trapunlock PLATEID</code><br>" +
            "Plate Messages:<br><code>!mech platemsgon PLATEID ...</code>, <code>!mech platemsgoff PLATEID ...</code><br>" +
            "Groups:<br>" +
            "<code>!mech grouplock NAME</code> (mechanism lock), <code>!mech groupcfglock NAME</code> (config lock), <code>!mech groupoverride NAME</code> (60s override)<br>" +
            "<code>!mech groupautolock NAME</code>, <code>!mech groupreset NAME</code><br>" +
            "<code>!mech groupmake NAME [K]</code>, <code>!mech groupaddplates NAME</code>, <code>!mech groupadddoors NAME lock|secret</code><br>" +
            "<code>!mech groupmsgon NAME ...</code>, <code>!mech groupmsgoff NAME ...</code><br>" +
            "<code>!mech groupdelplate NAME PLATEID</code>, <code>!mech groupdeldor NAME DOORID</code>, <code>!mech groupremove NAME</code>"
        );
    }

    function handleUiCommands(msg, sub) {
        if (sub === "ui") {
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "setpage") {
            setUIPage(msg.playerid);
            renderUI(msg.playerid);
            return true;
        }
        return false;
    }

    function handleSingleCommands(msg, sub, a, b, restFrom) {
        if (sub === "make") {
            cmdMakePlateFromSelected(msg, a);
            return true;
        }
        if (sub === "add") {
            cmdAddSingle(msg, a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "check") {
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "checkplate") {
            if (a) evaluateSingleMechanism(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "simopen") {
            if (a) cmdSimOpen(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "simclose") {
            if (a) cmdSimClose(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "removeplate") {
            if (a) cmdRemoveSingleMechanism(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "platemsgon") {
            if (a) cmdSetSingleMessageOn(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "platemsgoff") {
            if (a) cmdSetSingleMessageOff(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "ping") {
            if (a) cmdPingSource(msg.playerid, a);
            return true;
        }
        return false;
    }

    function handleTrapCommands(msg, sub, a, b, restFrom) {
        if (sub === "trapui") {
            if (a) renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "traptoggle") {
            if (a) cmdTrapToggle(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "traptype") {
            if (a) cmdTrapType(a, b);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "traptrigger") {
            if (a) cmdTrapTrigger(a, b);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapmsg") {
            if (a) cmdTrapMessage(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapdamage") {
            if (a) cmdTrapDamage(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavelabel") {
            if (a) cmdTrapSaveLabel(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavedc") {
            if (a) cmdTrapSaveDc(a, b);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavesuccessmsg") {
            if (a) cmdTrapSaveSuccessMsg(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavefailmsg") {
            if (a) cmdTrapSaveFailMsg(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavesuccess") {
            if (a) cmdTrapSaveSuccessMode(a, b);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavedmgtype") {
            if (a) cmdTrapSaveDamageType(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsavefaildmg") {
            if (a) cmdTrapSaveFailDamage(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapstatusmarkers") {
            if (a) cmdTrapStatusMarkers(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapstatusclear") {
            if (a) cmdTrapStatusClearToggle(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsetteleport") {
            if (a) cmdTrapSetTeleport(msg, a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapclearteleport") {
            if (a) cmdTrapClearTeleport(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsetreveal") {
            if (a) cmdTrapSetReveal(msg, a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapclearreveal") {
            if (a) cmdTrapClearReveal(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "traprevealtoggle") {
            if (a) cmdTrapRevealToggle(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapsetspawn") {
            if (a) cmdTrapSetSpawn(msg, a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapclearspawn") {
            if (a) cmdTrapClearSpawn(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "traplocktoggle") {
            if (a) cmdTrapLockToggle(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "traplockmarker") {
            if (a) cmdTrapLockMarker(a, restFrom(3));
            renderTrapUI(msg.playerid, a);
            return true;
        }
        if (sub === "trapunlock") {
            if (a) cmdTrapUnlock(a);
            renderTrapUI(msg.playerid, a);
            return true;
        }
        return false;
    }

    function handleGroupCommands(msg, sub, a, b, restFrom) {
        if (sub === "groupmake") {
            cmdCreateMultiMechanismFromSelected(msg, a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupaddplates") {
            cmdAddSourcesToMultiMechanism(msg, a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupadddoors") {
            cmdAddDoorsToMultiMechanism(msg, a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupsetall") {
            cmdSetMultiMechanismRequireAll(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupsetk") {
            cmdSetMultiMechanismRequiredCount(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "grouplock") {
            cmdToggleMechanismLock(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupcfglock") {
            cmdToggleMechanismConfigLock(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupoverride") {
            cmdEnableMechanismOverride(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupautolock") {
            cmdToggleMechanismAutoLock(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupreset") {
            cmdResetMechanismTriggerState(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupremove") {
            cmdRemoveMultiMechanism(a);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupcheck") {
            evaluateMultiSourceMechanism(a);
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupdelplate") {
            cmdRemoveSourceFromMultiMechanism(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupdeldor") {
            cmdRemoveDoorFromMultiMechanism(a, b);
            evaluateAll();
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupmsgon") {
            if (a) cmdSetMultiMechanismMessageOn(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "groupmsgoff") {
            if (a) cmdSetMultiMechanismMessageOff(a, restFrom(3));
            renderUI(msg.playerid);
            return true;
        }
        return false;
    }

    /* ---------- events ---------- */
    on("change:graphic", function (obj, prev) {
        if (obj.get("layer") !== "objects") return;
        if (obj.get("_subtype") !== "token") return;

        if (MOVE_LOCK_REENTRY[obj.id]) {
            delete MOVE_LOCK_REENTRY[obj.id];
            return;
        }

        var st = ensureState();
        var lock = st.lockedTokens[obj.id];
        if (lock) {
            var moved = (
                obj.get("left") !== lock.left ||
                obj.get("top") !== lock.top ||
                obj.get("_pageid") !== lock.pageId
            );

            if (moved) {
                MOVE_LOCK_REENTRY[obj.id] = true;
                obj.set({ left: lock.left, top: lock.top, _pageid: lock.pageId, layer: "objects" });
                return;
            }
        }

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
        if (parts[0] !== "!mech") return;

        var sub = (parts[1] || "").toLowerCase();
        var a = parts[2];
        var b = parts[3];

        // helper to capture the rest of the message (allows spaces)
        function restFrom(n) {
            return msg.content.split(/\s+/).slice(n).join(" ");
        }

        if (handleUiCommands(msg, sub)) return;
        if (handleSingleCommands(msg, sub, a, b, restFrom)) return;
        if (handleTrapCommands(msg, sub, a, b, restFrom)) return;
        if (handleGroupCommands(msg, sub, a, b, restFrom)) return;

        showCommandHelp();
    });

    on("ready", function () {
        ensureState();
        evaluateAll();
        sendChat("", "/w gm Loaded ✅  UI: !mech ui   (State key: " + STATE + ")");
    });

    return {};
})();
