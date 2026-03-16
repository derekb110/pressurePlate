Trigger Mechanisms (Roll20 API)

A full-featured pressure plate and door control system for Roll20.

Supports:

Single-source trigger → multiple doors

K-of-N multi-source trigger puzzles

Single-source mechanisms with separate primary effect configuration UI

Secret doors and locked doors

Trigger & release messages

Trigger types: pressure plate, tripwire, proximity, manual, lever, button, door state

Primary effect types: alarm, damage, projectile, teleport, pit/force-move, reveal, save, status, spawn

Additional effect: lock triggered token(s) in place

Auto-lock puzzles

One-shot, cooldown, and delay rules

Mechanism lock & config lock systems

Teleport-style GM UI panel

Ping support

Safe state persistence across script updates

Features
Single-Source Triggers

Bind one trigger to multiple doors

Supports:

Locked doors (open/unlock when pressed)

Secret doors (reveal/open when pressed)

Optional trigger and release chat messages

Optional primary effect configuration with a dedicated effect menu

Multi-Source Mechanisms

Multiple plates controlling multiple doors

Require ALL or K-of-N plates

Edge-triggered messaging

Optional auto-lock after first activation

Resettable puzzles

Locking Systems

Mechanism Lock – disables triggers

Freeze Mode – locks doors in current state

Config Lock – prevents accidental edits

Override Mode – 60-second edit unlock

UI

Teleport-style mechanism list and editor

Per-page display

Ping buttons

Bind and detach controls

Visual status badges (ACTIVE / INACTIVE / LOCKED / CONFIG)

Installation

Open your Roll20 game.

Go to Settings → API Scripts.

Create a new script.

Paste the full script.

Save.

Open the UI with:

!mech ui

Basic Usage
Create a Trigger

Select one or more trigger tokens, or select Door Tool doors for a door-state trigger, and run:

!mech make TriggerName

You can also create a specific trigger type:

!mech make TripwireA tripwire
!mech make DangerZone proximity
!mech make LeverA lever
!mech make ButtonA button
!mech make FrontDoor doorState


Trigger tokens are automatically moved to the GM layer.

Bind Doors to a Single Trigger

Select:

The trigger token (GM layer)

One or more Door Tool doors

Then run:

!mech add lock


or

!mech add secret

Configure Trigger Type and Primary Effect

Open the main UI:

!mech ui

Then click the effect button on a single-source mechanism, or open the effect UI directly:

!mech effectui SOURCEID

From the effect UI you can:

Choose a trigger type

Choose a primary effect type

Choose whether it fires on press, release, or both

Set an effect message

Configure effect-specific settings like damage, save DC, markers, reveal targets, spawn targets, or teleport destination

Optionally enable the lock-token effect

For non-reveal primary effect types, you can also enable reveal as an extra effect so a save, damage, or spawn effect can reveal hidden targets at the same time.

Rule controls:

You can add a delay before activation, a cooldown after activation, or one-shot behavior so a mechanism only activates once until reset.

Use:

!mech ruledelay REF 1.5
!mech rulecooldown REF 10
!mech ruleoneshot REF on
!mech reset REF

Primary Effect Setup Notes

Trigger type setup:

Pressure plate:

When it fires:

The token must be fully inside the trigger token bounds.

Best for:

Classic floor plates, pedestal switches, weighted pressure tiles, and puzzle plates.

Notes:

This is the most precise trigger type. Partial overlap does not count.

Tripwire:

When it fires:

Any part of a token overlaps the trigger token bounds.

Best for:

Hallway wires, laser lines, threshold traps, and narrow crossing points.

Notes:

Use a thin or narrow token shape on the GM layer to represent the wire path. This is less strict than a pressure plate and will fire on partial overlap.

Proximity:

When it fires:

A token comes within a configurable radius of the trigger token.

Best for:

Magic wards, scent/sound triggers, sentry zones, cursed objects, and area-based ambushes.

Notes:

The range is measured in map cells from the trigger token. Larger trigger tokens still use their token center as the anchor, so test the feel in-game if you want a tight detection ring.

Set the radius in cells with:

!mech proximityrange SOURCEID 2

Manual:

When it fires:

Only when the GM explicitly turns it on.

Best for:

Hidden switches, remote controls, GM-timed events, story beats, and triggers that should not depend on token movement at all.

Notes:

This is useful when you want the mechanism engine, effects, and door logic, but not automatic detection from a token entering an area.

Use:

!mech manualon SOURCEID
!mech manualoff SOURCEID
!mech manualtoggle SOURCEID

Lever:

When it fires:

Only when the GM flips it on.

Best for:

Wall levers, hidden switch handles, mechanical puzzle arms, and reusable toggle controls.

Notes:

This is a persistent controlled trigger. Unlike a button, it stays on until you flip it back off.

Use:

!mech leveron SOURCEID
!mech leveroff SOURCEID
!mech levertoggle SOURCEID

Button:

When it fires:

Only when the GM presses it.

Best for:

Push plates, magical glyph buttons, panel switches, and any control you want to press and release separately.

Notes:

This is the same controlled model as manual and lever, but with button-style labels in the UI and commands.

Use:

!mech buttonpress SOURCEID
!mech buttonrelease SOURCEID
!mech buttontoggle SOURCEID

Door state:

When it fires:

The selected Roll20 Door Tool door matches a configured state like open, closed, locked, unlocked, revealed, or hidden.

Best for:

Linked encounters, chained room logic, doors that trigger ambushes when opened, and mechanisms that react to how a real Roll20 door object changes over time.

Notes:

This uses the actual Roll20 Door Tool door on the map, not a token pretending to be a door.

Create a door-state trigger by selecting one or more door objects, then use:

!mech make NAME doorState

Set the watched door state with:

!mech doorstatemode SOURCEID open
!mech doorstatemode SOURCEID closed
!mech doorstatemode SOURCEID locked
!mech doorstatemode SOURCEID unlocked
!mech doorstatemode SOURCEID revealed
!mech doorstatemode SOURCEID hidden

Teleport effects:

Select one destination marker token/graphic, then use:

!mech effectsetteleport SOURCEID

Reveal effects:

Select one or more hidden graphics or secret doors, then use:

!mech effectsetreveal SOURCEID

Spawn effects:

Select one or more GM-layer graphics to reveal on trigger, then use:

!mech effectsetspawn SOURCEID

Status effects:

Use comma-separated Roll20 status marker names, for example:

!mech effectstatusmarkers SOURCEID cobweb,poisoned

Lock token effect:

When enabled, triggered token(s) are snapped back to their locked position until manually unlocked.

Use:

!mech effectunlock SOURCEID

Create a Group Puzzle

Select multiple plate tokens:

!mech groupmake PuzzleA 2


This creates a group requiring 2 plates.

Add doors:

!mech groupadddoors PuzzleA lock

Command Reference
!mech ui
!mech setpage
!mech check

!mech make NAME [pressurePlate|tripwire|proximity|manual|lever|button|doorState]
!mech add lock
!mech add secret
!mech sourcetype SOURCEID pressurePlate|tripwire|proximity|manual|lever|button|doorState
!mech doorstatemode SOURCEID open|closed|locked|unlocked|revealed|hidden
!mech proximityrange SOURCEID CELLS
!mech manualon SOURCEID
!mech manualoff SOURCEID
!mech manualtoggle SOURCEID
!mech leveron SOURCEID
!mech leveroff SOURCEID
!mech levertoggle SOURCEID
!mech buttonpress SOURCEID
!mech buttonrelease SOURCEID
!mech buttontoggle SOURCEID
!mech ruledelay REF SECONDS
!mech rulecooldown REF SECONDS
!mech ruleoneshot REF on|off
!mech reset REF
!mech effectui SOURCEID
!mech effecttoggle SOURCEID
!mech effecttype SOURCEID alarm|damage|projectile|teleport|pit|reveal|save|status|spawn|none
!mech effecttrigger SOURCEID press|release|both
!mech effectmsg SOURCEID message...
!mech effectdamage SOURCEID XdY
!mech effectprojectilename SOURCEID label...
!mech effectprojectiledmgtype SOURCEID TYPE
!mech effectsavelabel SOURCEID LABEL
!mech effectsavedc SOURCEID DC
!mech effectsavesuccessmsg SOURCEID message...
!mech effectsavefailmsg SOURCEID message...
!mech effectsavesuccess SOURCEID half|none
!mech effectsavedmgtype SOURCEID TYPE
!mech effectsavefaildmg SOURCEID XdY
!mech effectstatusmarkers SOURCEID marker1,marker2
!mech effectstatusclear SOURCEID
!mech effectsetteleport SOURCEID
!mech effectclearteleport SOURCEID
!mech effectsetpit SOURCEID
!mech effectclearpit SOURCEID
!mech effectpitdamage SOURCEID XdY
!mech effectpitdmgtype SOURCEID TYPE
!mech effectsetreveal SOURCEID
!mech effectclearreveal SOURCEID
!mech effectrevealtoggle SOURCEID
!mech effectsetspawn SOURCEID
!mech effectclearspawn SOURCEID
!mech effectlocktoggle SOURCEID
!mech effectlockmarker SOURCEID MARKER
!mech effectunlock SOURCEID
!mech checkplate SOURCEID
!mech simopen SOURCEID
!mech simclose SOURCEID
!mech removeplate SOURCEID
!mech ping SOURCEID

!mech platemsgon SOURCEID message...
!mech platemsgoff SOURCEID message...

!mech groupmake NAME [K]
!mech groupaddplates NAME
!mech groupadddoors NAME lock
!mech groupadddoors NAME secret
!mech groupsetall NAME
!mech groupsetk NAME K

!mech grouplock NAME
!mech groupcfglock NAME
!mech groupoverride NAME
!mech groupautolock NAME
!mech groupreset NAME

!mech groupremove NAME
!mech groupdelplate NAME SOURCEID
!mech groupdeldor NAME DOORID


All commands have UI buttons.

How Doors Behave
LOCK mode

Pressed:

Door opens

Door unlocks

Released:

Door closes

Door locks

SECRET mode

Pressed:

Door reveals

Door opens

Door unlocks

Released:

Door hides

Door closes

Door locks

Primary Effect Modes

ALARM

Posts an effect narration message when triggered.

DAMAGE

Posts a damage roll message against the token(s) on the plate.

PROJECTILE

Posts a flavored projectile attack message with a damage roll and damage type.

TELEPORT

Moves the token(s) on the plate to a saved destination marker.

PIT / FORCE MOVE

Moves the token(s) to a configured destination marker and can also apply optional pit or fall damage.

REVEAL

Reveals selected GM-layer graphics or secret doors.

Reveal can also be used as an extra effect on non-reveal primary effect types.

SAVE

Prompts a save or check with configurable DC, messages, fail damage, damage type, and a success result of either half or none.

STATUS

Applies configurable token markers to triggered token(s), with optional clear on release.

SPAWN

Moves selected GM-layer spawn tokens to the objects layer when triggered.

LOCK TOKEN EFFECT

Optional extra effect that holds triggered token(s) in place until manually unlocked.

Examples

Dart effect with save-for-half

!mech effecttype SOURCEID save
!mech effectsavelabel SOURCEID DEX
!mech effectsavedc SOURCEID 14
!mech effectsavesuccess SOURCEID half
!mech effectsavedmgtype SOURCEID piercing
!mech effectsavefaildmg SOURCEID 2d4
!mech effectmsg SOURCEID A volley of darts fires from the wall.

Reveal-and-save effect

!mech effecttype SOURCEID save
!mech effectrevealtoggle SOURCEID
!mech effectsavelabel SOURCEID DEX
!mech effectsavedc SOURCEID 15
!mech effectsavesuccess SOURCEID none
!mech effectsavedmgtype SOURCEID fire
!mech effectsavefaildmg SOURCEID 3d6
!mech effectmsg SOURCEID Flame jets burst from hidden wall vents.

Web snare effect

!mech effecttype SOURCEID status
!mech effectstatusmarkers SOURCEID cobweb
!mech effectlocktoggle SOURCEID
!mech effectmsg SOURCEID Sticky webbing erupts from the floor.

Ambush spawn effect

!mech effecttype SOURCEID spawn
!mech effectmsg SOURCEID Hidden attackers rush into the room.

Arrow slit projectile

!mech effecttype SOURCEID projectile
!mech effectprojectilename SOURCEID Arrow volley
!mech effectdamage SOURCEID 2d6
!mech effectprojectiledmgtype SOURCEID piercing
!mech effectmsg SOURCEID Arrows launch from the murder holes.

Pit drop / force move

!mech effecttype SOURCEID pit
!mech effectsetpit SOURCEID
!mech effectpitdamage SOURCEID 2d6
!mech effectpitdmgtype SOURCEID bludgeoning
!mech effectmsg SOURCEID The floor opens beneath your feet.

Backward Compatibility

Existing pressure plates continue to work without conversion.

Primary effect configuration is additive and uses backfilled defaults, so older saved mechanism data should remain valid after script updates.

State Persistence

The script uses a persistent state key:

TM_CAMPAIGN_CORE


Do not change this key after deployment or bindings will appear lost.

Troubleshooting
Doors won’t bind

Make sure:

Plate token is on GM layer

You selected both plate and Door object

Door is created with Door Tool (not a drawn line)

Plates not triggering

Confirm tokens are fully inside plate bounds

Confirm mechanism lock is not enabled

Recommended Workflow

Use Config Lock once puzzles are finished.

Use Auto-Lock for one-shot dungeon puzzles.

Use Trigger Messages for cinematic reveals.

Use Ping to locate hidden plates during setup.
