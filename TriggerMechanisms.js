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
                trap: defaultTrapConfig()
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
            mechanisms: {},    // mechanismId -> normalized internal model for all mechanisms
            uiPageId: null,
            last: 0,
            editOverride: {},  // mechanismName -> expiry timestamp
            lockedTokens: {}   // tokenId -> { sourceId, left, top, pageId, marker }
        };

        var st = state[STATE];
        var mechId;

        if (!st.mechanisms) st.mechanisms = {};
        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            backfillMechanismData(st.mechanisms[mechId]);
        }
        if (!st.editOverride) st.editOverride = {};
        if (!st.lockedTokens) st.lockedTokens = {};

        return st;
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
        backfillMechanismData(st.mechanisms[mechId]);
        return st.mechanisms[mechId];
    }

    function inferMechanismPageId(sourceIds) {
        for (var i = 0; i < sourceIds.length; i++) {
            var g = getObj("graphic", sourceIds[i]);
            if (g) return g.get("_pageid");
        }
        return "";
    }

    function backfillMechanismData(mech) {
        mech = mech || {};
        if (typeof mech.kind === "undefined") mech.kind = "single";
        if (typeof mech.legacyId === "undefined") mech.legacyId = "";
        if (typeof mech.sourceKind === "undefined") mech.sourceKind = "pressurePlate";
        if (typeof mech.name === "undefined") mech.name = "";
        if (typeof mech.pageId === "undefined") mech.pageId = "";
        if (!mech.sources) mech.sources = [];
        mech.rule = mech.rule || {};
        if (typeof mech.rule.mode === "undefined") mech.rule.mode = mech.kind === "single" ? "single" : "kofn";
        if (typeof mech.rule.k === "undefined") mech.rule.k = mech.kind === "single" ? 1 : mech.sources.length;
        if (typeof mech.rule.timing === "undefined") mech.rule.timing = "press";
        mech.effects = mech.effects || {};
        if (!mech.effects.doors) mech.effects.doors = {};
        if (mech.kind === "single" || mech.effects.trap) mech.effects.trap = backfillTrapConfig(mech.effects.trap);
        else mech.effects.trap = null;
        mech.messages = mech.messages || {};
        if (typeof mech.messages.on === "undefined") mech.messages.on = "";
        if (typeof mech.messages.off === "undefined") mech.messages.off = "";
        mech.locks = mech.locks || {};
        if (typeof mech.locks.mechanismLocked === "undefined") mech.locks.mechanismLocked = false;
        if (typeof mech.locks.freezeWhenLocked === "undefined") mech.locks.freezeWhenLocked = false;
        if (typeof mech.locks.configLocked === "undefined") mech.locks.configLocked = false;
        if (typeof mech.locks.autoLock === "undefined") mech.locks.autoLock = false;
        if (typeof mech.locks.hasTriggered === "undefined") mech.locks.hasTriggered = false;
        mech.runtime = mech.runtime || {};
        if (typeof mech.runtime.lastActive === "undefined") mech.runtime.lastActive = false;
        if (!mech.runtime.lastOccupants) mech.runtime.lastOccupants = [];
        return mech;
    }

    function getSingleMechanism(plateId) {
        var mechId = singleMechanismId(plateId);
        var plate = getObj("graphic", plateId);
        var mech = ensureMechanismData(mechId);
        backfillMechanismData(mech);
        mech.kind = "single";
        mech.legacyId = plateId;
        mech.sourceKind = "pressurePlate";
        mech.name = (plate && plate.get("name")) || mech.name || ("Trigger …" + shortId(plateId));
        mech.pageId = plate ? plate.get("_pageid") : mech.pageId;
        mech.sources = [plateId];
        mech.rule.mode = "single";
        mech.rule.k = 1;
        mech.effects.trap = backfillTrapConfig(mech.effects.trap);
        return mech;
    }

    function getMultiMechanism(mechanismName, createMissing) {
        var mechId = multiMechanismId(mechanismName);
        var st = ensureState();
        if (!createMissing && !st.mechanisms[mechId]) return null;
        var mech = ensureMechanismData(mechId);
        backfillMechanismData(mech);
        mech.kind = "group";
        mech.legacyId = mechanismName;
        mech.sourceKind = "pressurePlate";
        mech.name = mechanismName;
        mech.pageId = inferMechanismPageId(mech.sources || []);
        if (mech.rule.mode === "single") mech.rule.mode = "kofn";
        if (mech.rule.k < 0) mech.rule.k = 0;
        mech.effects.trap = null;
        return mech;
    }

    function pruneAllMechanisms() {
        var st = ensureState();
        var mechId;
        for (mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            backfillMechanismData(st.mechanisms[mechId]);
            if (st.mechanisms[mechId].kind === "single") {
                if (!getObj("graphic", st.mechanisms[mechId].legacyId)) delete st.mechanisms[mechId];
                continue;
            }
            pruneMechanismSourcesAndDoors({
                plates: st.mechanisms[mechId].sources,
                doors: st.mechanisms[mechId].effects.doors
            });
            st.mechanisms[mechId].pageId = inferMechanismPageId(st.mechanisms[mechId].sources);
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

    function evaluateMechanism(mech) {
        if (!mech) return;
        backfillMechanismData(mech);

        if (mech.kind === "single") {
            var source = getObj("graphic", mech.sources[0]);
            if (!source) return;

            var trap = backfillTrapConfig(mech.effects.trap);
            var occupants = sourceOccupants(source);
            var prevOccupants = getGraphicsByIds(mech.runtime.lastOccupants);
            var wasActive = !!mech.runtime.lastActive;
            var occ = occupants.length > 0;

            if (occ && !wasActive) postTriggerMessage(mech.messages.on);
            if (!occ && wasActive) postTriggerMessage(mech.messages.off);

            applyDoorEffects(mech.effects.doors, occ);

            if (!occ && wasActive && trap.type === "status" && trap.status.clearOnRelease && mech.rule.timing === "press") {
                var clearMarkers = parseMarkerList(trap.status.markers);
                var clearTargets = getGraphicsByIds(trap.status.lastTargets);
                for (var i = 0; i < clearTargets.length; i++) removeMarkersFromToken(clearTargets[i], clearMarkers);
                trap.status.lastTargets = [];
            }

            if (trap && trapFiresOnEdge(mech.rule.timing, wasActive, occ)) {
                firePlateTrap(source, { trap: trap }, occ ? occupants : prevOccupants);
            }

            mech.runtime.lastActive = occ;
            mech.runtime.lastOccupants = [];
            for (i = 0; i < occupants.length; i++) mech.runtime.lastOccupants.push(occupants[i].id);
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
            return;
        }

        applyDoorEffects(mech.effects.doors, active);
    }

    function evaluateSingleMechanism(plateId) {
        evaluateMechanism(getSingleMechanism(plateId));
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
        evaluateMechanism(getMultiMechanism(mechanismName, false));
    }

    function evaluateAll() {
        var st = ensureState();
        pruneAllMechanisms();

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
        var mech = getMultiMechanism(mechanismName, false);
        if (!mech) return true;
        if (!mech.locks.configLocked) return true;
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

    function commitMechanism(mech) {
        if (!mech) return null;
        ensureState().mechanisms[mech.id] = mech;
        return mech;
    }

    function updateSingleMechanism(plateId, mutator) {
        var mech = getSingleMechanism(plateId);
        if (!mech) return null;
        mutator(mech);
        return commitMechanism(mech);
    }

    function updateGroupMechanism(name, createMissing, mutator) {
        var mech = getMultiMechanism(name, createMissing);
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

                getSingleMechanism(o.id);
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
        delete st.mechanisms[singleMechanismId(plateId)];

        // Also remove it from any groups
        for (var mechId in st.mechanisms) {
            if (!st.mechanisms.hasOwnProperty(mechId)) continue;
            if (st.mechanisms[mechId].kind !== "group") continue;
            updateGroupMechanism(st.mechanisms[mechId].legacyId, false, function (mech) {
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
        return renderMechanismEditor(playerid, plateId);
    }

    function resolveMechanismRef(ref) {
        var st = ensureState();
        if (st.mechanisms[ref]) return st.mechanisms[ref];
        if (getObj("graphic", ref)) return getSingleMechanism(ref);
        return getMultiMechanism(ref, false);
    }

    function renderMultiMechanismEditor(playerid, mech) {
        return renderMechanismEditor(playerid, mech.id || mech.legacyId);
    }

    function renderMechanismEditor(playerid, ref) {
        var mech = (typeof ref === "object") ? ref : resolveMechanismRef(ref);
        if (!mech) return whisper("Mechanism not found.");

        backfillMechanismData(mech);

        var isSingle = mech.kind === "single";
        var trap = isSingle ? backfillTrapConfig(mech.effects.trap) : null;
        var sourceId = isSingle ? mech.legacyId : "";
        var sourceObj = isSingle ? getObj("graphic", sourceId) : null;
        var active = mechanismIsActive(mech);
        var required = mechanismRequiredCount(mech);
        var pressed = countActiveMechanismSources(mech);
        var overrideActive = (!isSingle) && hasMechanismEditOverride(mech.legacyId);
        var editBlocked = (!isSingle) && mech.locks.configLocked && !overrideActive;
        var html = "";

        html += "<div style=\"border:2px solid #111;border-radius:12px;overflow:hidden;max-width:760px;font-family:Arial,sans-serif;\">";
        html += "<div style=\"background:#000;color:#fff;padding:10px 12px;\">";
        html += "<div style=\"font-weight:900;font-size:20px;\">Mechanism Configuration</div>";
        html += "<div style=\"color:#cfcfcf;font-weight:900;font-size:12px;margin-top:2px;\">" + esc(mechanismDisplayName(mech)) + " • " + esc(mechanismRuleSummary(mech)) + "</div>";
        html += "</div>";
        html += "<div style=\"background:#fff;padding:10px;\">";

        html += "<div style=\"border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;\">";
        html += badge(active ? "ACTIVE" : "INACTIVE", active);
        html += badge(isSingle ? "SINGLE" : "MULTI", false);
        if (isSingle) html += badge((trap.enabled && trap.type !== "none") ? "TRAP ENABLED" : "TRAP DISABLED", false);
        if (!isSingle && mech.locks.mechanismLocked) html += badge(mech.locks.freezeWhenLocked ? "FROZEN" : "LOCKED", false);
        if (!isSingle && mech.locks.configLocked) html += badge("CONFIG", false);
        if (overrideActive) html += badge("OVERRIDE", true);
        if (!isSingle && mech.locks.autoLock) html += badge("AUTOLOCK", true);
        html += "<div style=\"margin-top:8px;\">";
        html += iconBtn("↩️", "!mech ui", "Back to mechanism list");
        html += iconBtn("🔄", "!mech edit " + mech.legacyId, "Refresh mechanism configuration");
        if (isSingle) {
            html += iconBtn("🔍", "!mech ping " + sourceId, "Ping trigger");
            html += iconBtn("✅", "!mech checkplate " + sourceId, "Check mechanism");
            html += iconBtn("⬆️", "!mech simopen " + sourceId, "Force open (simulate triggered)");
            html += iconBtn("⬇️", "!mech simclose " + sourceId, "Force close (simulate released)");
            html += iconBtn("🗑️", "!mech removeplate " + sourceId, "Remove mechanism");
        } else {
            html += iconBtn("✅", "!mech groupcheck " + mech.legacyId, "Check mechanism");
            if (editBlocked) html += iconBtnDisabled("🗑️", "Config locked");
            else html += iconBtn("🗑️", "!mech groupremove " + mech.legacyId, "Remove mechanism");
        }
        if (isSingle) {
            html += iconBtn("💣", "!mech traptoggle " + sourceId, (trap.enabled && trap.type !== "none") ? "Disable trap" : "Enable trap");
        } else {
            html += iconBtn(mech.locks.mechanismLocked ? "🔒" : "🔓", "!mech grouplock " + mech.legacyId, "Toggle mechanism lock");
            html += iconBtn(mech.locks.configLocked ? "🧱" : "✏️", "!mech groupcfglock " + mech.legacyId, "Toggle config lock");
            html += iconBtn(mech.locks.autoLock ? "⭐" : "☆", "!mech groupautolock " + mech.legacyId, "Toggle auto-lock after first trigger");
            html += iconBtn("🔁", "!mech groupreset " + mech.legacyId, "Reset trigger state");
        }
        html += "</div>";
        if (isSingle && sourceObj) {
            html += "<div style=\"margin-top:8px;font-weight:900;\">State: <span style=\"color:#333;\">" + esc(isSourceOccupied(sourceObj) ? "OCCUPIED" : "CLEAR") + "</span></div>";
        } else if (!isSingle) {
            html += "<div style=\"margin-top:8px;font-weight:900;\">Pressed: <span style=\"color:#333;\">" + esc(String(pressed)) + "/" + esc(String(required)) + "</span></div>";
        }
        html += "</div>";

        if (!isSingle) {
            html += "<div style=\"border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;\">";
            html += "<div style=\"font-weight:900;font-size:16px;margin-bottom:6px;\">Locking</div>";
            html += "<div style=\"margin-top:4px;font-weight:900;\">Mechanism lock: <span style=\"color:#333;\">" + esc(mech.locks.mechanismLocked ? (mech.locks.freezeWhenLocked ? "FROZEN" : "LOCKED") : "UNLOCKED") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Config lock: <span style="color:#333;">' + esc(mech.locks.configLocked ? "LOCKED" : "UNLOCKED") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Auto-lock: <span style="color:#333;">' + esc(mech.locks.autoLock ? "ON" : "OFF") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Override: <span style="color:#333;">' + esc(overrideActive ? "ACTIVE" : "INACTIVE") + "</span></div>";
            html += "</div>";
        }

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Messages</div>';
        if (isSingle) {
            html += mini("Set On", "!mech platemsgon " + sourceId + " ?{Trigger message|}", "Set trigger message");
            html += mini("Set Off", "!mech platemsgoff " + sourceId + " ?{Release message|}", "Set release message");
        } else if (editBlocked) {
            html += miniDisabled("Set On", "Config locked");
            html += miniDisabled("Set Off", "Config locked");
        } else {
            html += mini("Set On", "!mech groupmsgon " + mech.legacyId + " ?{Trigger message|}", "Set trigger message");
            html += mini("Set Off", "!mech groupmsgoff " + mech.legacyId + " ?{Release message|}", "Set release message");
        }
        html += '<div style="margin-top:8px;font-weight:900;">On: <span style="color:#333;">' + esc(mech.messages.on || "(none)") + "</span></div>";
        html += '<div style="margin-top:4px;font-weight:900;">Off: <span style="color:#333;">' + esc(mech.messages.off || "(none)") + "</span></div>";
        if (isSingle) {
            html += '<div style="margin-top:8px;font-weight:900;">Trap message: <span style="color:#333;">' + esc(String(trap.message || "").trim() || "(none)") + "</span></div>";
            html += mini("Set trap message", "!mech trapmsg " + sourceId + " ?{Trap message|}", "Set trap narration");
        }
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Rule</div>';
        if (isSingle) {
            html += mini("Press", "!mech traptrigger " + sourceId + " press", "Fire on press");
            html += mini("Release", "!mech traptrigger " + sourceId + " release", "Fire on release");
            html += mini("Both", "!mech traptrigger " + sourceId + " both", "Fire on press and release");
        } else if (editBlocked) {
            html += miniDisabled("Require ALL", "Config locked");
            html += miniDisabled("Set K", "Config locked");
        } else {
            html += mini("Require ALL", "!mech groupsetall " + mech.legacyId, "Require all sources");
            html += mini("Set K", "!mech groupsetk " + mech.legacyId + " ?{Require how many sources?|2}", "Set K-of-N");
        }
        html += '<div style="margin-top:8px;font-weight:900;">Current: <span style="color:#333;">' + esc(mechanismRuleSummary(mech)) + "</span></div>";
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Sources</div>';
        if (!isSingle) {
            if (editBlocked) html += miniDisabled("Add selected sources", "Config locked");
            else html += mini("Add selected sources", "!mech groupaddplates " + mech.legacyId, "Add selected sources");
        }
        for (var i = 0; i < mech.sources.length; i++) {
            var src = getObj("graphic", mech.sources[i]);
            if (!src) continue;
            html += '<div style="margin-top:6px;font-weight:900;">' + esc(src.get("name") || ("Trigger …" + shortId(src.id))) + ' ';
            html += mini("Ping", "!mech ping " + src.id, "Ping source");
            if (!isSingle) {
                if (editBlocked) html += miniDisabled("Remove", "Config locked");
                else html += mini("Remove", "!mech groupdelplate " + mech.legacyId + " " + src.id, "Remove source");
            }
            html += "</div>";
        }
        if (!mech.sources.length) html += '<div style="margin-top:6px;color:#666;font-weight:900;">(No sources)</div>';
        html += "</div>";

        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Doors</div>';
        if (isSingle) {
            html += mini("Bind LOCK doors", "!mech add lock", "Select this source and doors, then click");
            html += mini("Bind SECRET doors", "!mech add secret", "Select this source and doors, then click");
        } else if (editBlocked) {
            html += miniDisabled("Add LOCK", "Config locked");
            html += miniDisabled("Add SECRET", "Config locked");
        } else {
            html += mini("Add LOCK", "!mech groupadddoors " + mech.legacyId + " lock", "Bind selected doors as lock");
            html += mini("Add SECRET", "!mech groupadddoors " + mech.legacyId + " secret", "Bind selected doors as secret");
        }
        for (var doorId in mech.effects.doors) {
            if (!mech.effects.doors.hasOwnProperty(doorId)) continue;
            html += '<div style="margin-top:6px;font-weight:900;">' + esc(String(mech.effects.doors[doorId]).toUpperCase()) + " door …" + esc(shortId(doorId)) + " ";
            if (!isSingle) {
                if (editBlocked) html += miniDisabled("Detach", "Config locked");
                else html += mini("Detach", "!mech groupdeldor " + mech.legacyId + " " + doorId, "Detach door");
            }
            html += "</div>";
        }
        if (!Object.keys(mech.effects.doors).length) html += '<div style="margin-top:6px;color:#666;font-weight:900;">(No doors)</div>';
        html += "</div>";

        if (isSingle) {
            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Primary Effect</div>';
            html += mini("Alarm", "!mech traptype " + sourceId + " alarm", "Narration or warning trap");
            html += mini("Damage", "!mech traptype " + sourceId + " damage", "Damage trap");
            html += mini("Save", "!mech traptype " + sourceId + " save", "Save/check prompt trap");
            html += mini("Status", "!mech traptype " + sourceId + " status", "Apply status markers");
            html += mini("Spawn", "!mech traptype " + sourceId + " spawn", "Reveal selected spawn tokens");
            html += mini("Teleport", "!mech traptype " + sourceId + " teleport", "Teleport occupants");
            html += mini("Reveal", "!mech traptype " + sourceId + " reveal", "Reveal hidden targets");
            html += mini("Disable", "!mech traptype " + sourceId + " none", "Disable trap without removing mechanism");
            html += '<div style="margin-top:8px;font-weight:900;">Current type: <span style="color:#333;">' + esc(trapTypeLabel(trap.type)) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Effects: <span style="color:#333;">' + esc(mechanismEffectSummary(mech)) + "</span></div>";
            html += "</div>";

            if (trap.type === "damage") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Damage</div>';
                html += mini("Set damage", "!mech trapdamage " + sourceId + " ?{Damage roll|1d6}", "Set damage roll");
                html += '<div style="margin-top:8px;font-weight:900;">Damage: <span style="color:#333;">' + esc(trap.damage) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "save") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Save</div>';
                html += mini("Set label", "!mech trapsavelabel " + sourceId + " ?{Save label|DEX}", "Set save label");
                html += mini("Set DC", "!mech trapsavedc " + sourceId + " ?{Save DC|12}", "Set save DC");
                html += mini("Set success text", "!mech trapsavesuccessmsg " + sourceId + " ?{Success text|}", "Set success text");
                html += mini("Set fail text", "!mech trapsavefailmsg " + sourceId + " ?{Fail text|}", "Set fail text");
                html += mini("Success HALF", "!mech trapsavesuccess " + sourceId + " half", "Success takes half damage");
                html += mini("Success NONE", "!mech trapsavesuccess " + sourceId + " none", "Success takes no damage");
                html += mini("Set dmg type", "!mech trapsavedmgtype " + sourceId + " ?{Damage type|piercing|slashing|bludgeoning|acid|cold|fire|force|lightning|necrotic|poison|psychic|radiant|thunder}", "Set damage type");
                html += mini("Set fail damage", "!mech trapsavefaildmg " + sourceId + " ?{Fail damage|1d6}", "Set fail damage");
                html += '<div style="margin-top:8px;font-weight:900;">Save: <span style="color:#333;">' + esc(String(trap.save.label).toUpperCase()) + " DC " + esc(String(trap.save.dc)) + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Success result: <span style="color:#333;">' + esc(String(trap.save.successMode || "none").toUpperCase()) + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Damage type: <span style="color:#333;">' + esc(String(trap.save.damageType || "").trim() || "(none)") + "</span></div>";
                html += '<div style="margin-top:4px;font-weight:900;">Fail damage: <span style="color:#333;">' + esc(String(trap.save.failDamage || "").trim() || "(none)") + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "status") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Status</div>';
                html += mini("Set markers", "!mech trapstatusmarkers " + sourceId + " ?{Markers (comma-separated)|cobweb}", "Set markers");
                html += mini(trap.status.clearOnRelease ? "Clear on release: ON" : "Clear on release: OFF", "!mech trapstatusclear " + sourceId, "Toggle clear on release");
                html += '<div style="margin-top:8px;font-weight:900;">Markers: <span style="color:#333;">' + esc(describeStatusMarkers(trap)) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "teleport") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Teleport</div>';
                html += mini("Set destination", "!mech trapsetteleport " + sourceId, "Set destination from selection");
                html += mini("Clear destination", "!mech trapclearteleport " + sourceId, "Clear destination");
                html += '<div style="margin-top:8px;font-weight:900;">Destination: <span style="color:#333;">' + esc(describeTeleportDestination(trap)) + "</span></div>";
                html += "</div>";
            }

            if (trap.type === "reveal" || trap.type === "spawn") {
                html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;">';
                html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Effect Targets</div>';
                if (trap.type === "reveal") {
                    html += mini("Set reveal targets", "!mech trapsetreveal " + sourceId, "Set reveal targets from selection");
                    html += mini("Clear reveal targets", "!mech trapclearreveal " + sourceId, "Clear reveal targets");
                    html += '<div style="margin-top:8px;font-weight:900;">Reveal targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
                } else {
                    html += mini("Set spawn targets", "!mech trapsetspawn " + sourceId, "Set spawn targets from selection");
                    html += mini("Clear spawn targets", "!mech trapclearspawn " + sourceId, "Clear spawn targets");
                    html += '<div style="margin-top:8px;font-weight:900;">Spawn targets: <span style="color:#333;">' + esc(describeSpawnTargets(trap)) + "</span></div>";
                }
                html += "</div>";
            }

            html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
            html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Extra Effects</div>';
            if (trap.type !== "reveal") html += mini(trap.effects.revealAlso ? "Reveal targets: ON" : "Reveal targets: OFF", "!mech traprevealtoggle " + sourceId, "Toggle reveal effect");
            html += mini("Set reveal targets", "!mech trapsetreveal " + sourceId, "Set reveal targets");
            html += mini("Clear reveal targets", "!mech trapclearreveal " + sourceId, "Clear reveal targets");
            html += mini(trap.effects.lockToken ? "Lock token: ON" : "Lock token: OFF", "!mech traplocktoggle " + sourceId, "Toggle lock token effect");
            html += mini("Set lock marker", "!mech traplockmarker " + sourceId + " ?{Lock marker|fishing-net}", "Set lock marker");
            html += mini("Unlock tokens", "!mech trapunlock " + sourceId, "Unlock affected tokens");
            html += '<div style="margin-top:8px;font-weight:900;">Reveal targets: <span style="color:#333;">' + esc(describeRevealTargets(trap)) + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Lock effect: <span style="color:#333;">' + esc(trap.effects.lockToken ? "ON" : "OFF") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Lock marker: <span style="color:#333;">' + esc(String(trap.effects.lockMarker || "").trim() || "(none)") + "</span></div>";
            html += '<div style="margin-top:4px;font-weight:900;">Locked tokens: <span style="color:#333;">' + esc(String(lockedCountForSource(sourceId))) + "</span></div>";
            html += "</div>";
        }

        html += "</div></div>";
        whisper(html);
    }

    /* ---------- commands: groups ---------- */
    function cmdCreateMultiMechanismFromSelected(msg, name, required) {
        if (!name) { whisper("Usage: <code>!mech groupmake NAME [K]</code>"); return; }
        if (!requireMechanismConfigEditable(name)) return;

        required = parseInt(required, 10);
        if (isNaN(required) || required < 0) required = 0;
        var mech = getMultiMechanism(name, true);
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

                getSingleMechanism(o.id);
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

        var mech = getMultiMechanism(name, true);
        var sel = msg.selected || [];
        var added = 0;

        for (var i = 0; i < sel.length; i++) {
            var o = getObj(sel[i]._type, sel[i]._id);
            if (!o) continue;
            if (o.get("_type") === "graphic" && o.get("_subtype") === "token") {
                o.set({ layer: "gmlayer" });
                if (!o.get("name")) o.set({ name: "Plate " + shortId(o.id) });

                getSingleMechanism(o.id);
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

        var mech = getMultiMechanism(name, true);
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
        var mech = getMultiMechanism(name, false);
        if (!mech) return whisper("Group not found: " + esc(name));

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
        html += iconBtn("🧱", "!mech make ?{Trigger name|Pressure_Plate}", "Create single-source mechanism from selected trigger");
        html += iconBtn("🧭", "!mech setpage", "Use Current Page (Set)");
        html += iconBtn("🔄", "!mech ui", "Refresh UI");
        html += iconBtn("✅", "!mech check", "Force check all mechanisms");
        html += "</div>";

        // multi-source builder
        html += '<div style="border:2px solid #111;border-radius:10px;padding:10px;margin-bottom:10px;background:#fafafa;">';
        html += '<div style="font-weight:900;font-size:16px;margin-bottom:6px;">Multi-Source Builder</div>';
        html += '<div style="color:#333;font-weight:900;margin-bottom:8px;">Suggested name: <span style="font-family:monospace;">' + esc(suggested) + "</span></div>";

        html += mini("Create from selected triggers", "!mech groupmake ?{Mechanism Name (no spaces)|" + esc(suggested) + "} ?{Required K (0=ALL)|0}", "Create or update a multi-source mechanism");
        html += mini("Add selected triggers", "!mech groupaddplates ?{Mechanism Name (no spaces)|" + esc(suggested) + "}", "Add selected triggers to an existing mechanism");
        html += mini("Add selected LOCK doors", "!mech groupadddoors ?{Mechanism Name (no spaces)|" + esc(suggested) + "} lock", "Bind selected door(s) as LOCK effects");
        html += mini("Add selected SECRET doors", "!mech groupadddoors ?{Mechanism Name (no spaces)|" + esc(suggested) + "} secret", "Bind selected door(s) as SECRET effects");
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
            html += iconBtn("🛠️", "!mech edit " + mech.legacyId, "Edit mechanism");
            if (mech.kind === "single") {
                html += iconBtn("🔍", "!mech ping " + mech.legacyId, "Ping trigger");
                html += iconBtn("✅", "!mech checkplate " + mech.legacyId, "Check mechanism");
            } else {
                html += iconBtn("✅", "!mech groupcheck " + mech.legacyId, "Check mechanism");
            }

            html += '<div style="margin-top:6px;font-weight:900;">rule: <span style="font-weight:900;color:#333;">' + esc(mechanismRuleSummary(mech)) + "</span></div>";
            html += '<div style="margin-top:6px;font-weight:900;">effects: <span style="font-weight:900;color:#333;">' + esc(mechanismEffectSummary(mech)) + "</span></div>";
            html += '<div style="margin-top:6px;font-weight:900;">sources: <span style="font-weight:900;color:#333;">' + esc(String(mech.sources.length)) + "</span></div>";

            if (mech.kind === "group") {
                html += '<div style="margin-top:6px;font-weight:900;">status: <span style="font-weight:900;color:#333;">' + esc(String(pressed)) + "/" + esc(String(required)) + " pressed</span></div>";
                html += '<div style="margin-top:6px;font-weight:900;">locks: <span style="font-weight:900;color:#333;">' + esc(lockText) + (mech.locks.configLocked ? ", CONFIG" : "") + (mech.locks.autoLock ? ", AUTOLOCK" : "") + "</span></div>";
            }

            if (String(mech.messages.on || "").trim()) {
                html += '<div style="margin-top:6px;color:#111;font-weight:900;">On: <span style="font-weight:700;">' + esc(mech.messages.on) + "</span></div>";
            }
            if (String(mech.messages.off || "").trim()) {
                html += '<div style="margin-top:4px;color:#111;font-weight:900;">Off: <span style="font-weight:700;">' + esc(mech.messages.off) + "</span></div>";
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

                html += "<div style=\"margin-left:12px;margin-top:6px;font-weight:900;\">" +
                    esc(String(mech.effects.doors[did3]).toUpperCase()) + " door …" + esc(shortId(did3)) +
                    " <span style=\"color:#666;\">(" + esc(doorBits(d3)) + ")</span> ";

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
            "<code>!mech ui</code>, <code>!mech edit REF</code>, <code>!mech setpage</code>, <code>!mech make NAME</code>, <code>!mech add lock|secret</code>, <code>!mech check</code>, <code>!mech ping SOURCEID</code><br>" +
            "Single-Source Effects:<br><code>!mech trapui SOURCEID</code> (alias for edit), <code>!mech traptoggle SOURCEID</code>, <code>!mech traptype SOURCEID alarm|damage|teleport|reveal|save|status|spawn|none</code><br>" +
            "<code>!mech traptrigger SOURCEID press|release|both</code>, <code>!mech trapmsg SOURCEID ...</code>, <code>!mech trapdamage SOURCEID XdY</code><br>" +
            "<code>!mech trapsavelabel SOURCEID LABEL</code>, <code>!mech trapsavedc SOURCEID DC</code>, <code>!mech trapsavesuccessmsg SOURCEID ...</code>, <code>!mech trapsavefailmsg SOURCEID ...</code><br>" +
            "<code>!mech trapsavesuccess SOURCEID half|none</code>, <code>!mech trapsavedmgtype SOURCEID TYPE</code>, <code>!mech trapsavefaildmg SOURCEID XdY</code>, <code>!mech trapstatusmarkers SOURCEID marker1,marker2</code>, <code>!mech trapstatusclear SOURCEID</code><br>" +
            "<code>!mech trapsetteleport SOURCEID</code>, <code>!mech trapclearteleport SOURCEID</code>, <code>!mech trapsetreveal SOURCEID</code>, <code>!mech trapclearreveal SOURCEID</code>, <code>!mech traprevealtoggle SOURCEID</code><br>" +
            "<code>!mech trapsetspawn SOURCEID</code>, <code>!mech trapclearspawn SOURCEID</code>, <code>!mech traplocktoggle SOURCEID</code>, <code>!mech traplockmarker SOURCEID MARKER</code>, <code>!mech trapunlock SOURCEID</code><br>" +
            "Messages:<br><code>!mech platemsgon SOURCEID ...</code>, <code>!mech platemsgoff SOURCEID ...</code><br>" +
            "Multi-Source Mechanisms:<br>" +
            "<code>!mech grouplock NAME</code> (mechanism lock), <code>!mech groupcfglock NAME</code> (config lock), <code>!mech groupoverride NAME</code> (60s override)<br>" +
            "<code>!mech groupautolock NAME</code>, <code>!mech groupreset NAME</code><br>" +
            "<code>!mech groupmake NAME [K]</code>, <code>!mech groupaddplates NAME</code>, <code>!mech groupadddoors NAME lock|secret</code><br>" +
            "<code>!mech groupmsgon NAME ...</code>, <code>!mech groupmsgoff NAME ...</code><br>" +
            "<code>!mech groupdelplate NAME SOURCEID</code>, <code>!mech groupdeldor NAME DOORID</code>, <code>!mech groupremove NAME</code>"
        );
    }

    function handleUiCommands(msg, sub) {
        if (sub === "ui") {
            renderUI(msg.playerid);
            return true;
        }
        if (sub === "edit") {
            renderMechanismEditor(msg.playerid, msg.content.split(/\s+/)[2]);
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
