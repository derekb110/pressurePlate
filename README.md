Trigger Mechanisms (Roll20 API)

A full-featured pressure plate and door control system for Roll20.

Supports:

Single-source trigger → multiple doors

K-of-N multi-source trigger puzzles

Single-source mechanisms with separate primary effect configuration UI

Secret doors and locked doors

Trigger & release messages

Trigger types: pressure plate, tripwire, proximity, manual

Primary effect types: alarm, damage, teleport, reveal, save, status, spawn

Additional effect: lock triggered token(s) in place

Auto-lock puzzles

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

Select one or more tokens and run:

!mech make TriggerName

You can also create a specific trigger type:

!mech make TripwireA tripwire
!mech make DangerZone proximity
!mech make LeverA manual


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

Primary Effect Setup Notes

Trigger type setup:

Pressure plate:

Requires a token to be fully inside the source token bounds.

Tripwire:

Triggers when any token overlaps the source token bounds.

Proximity:

Triggers when a token comes within a configurable radius.

Set the radius in cells with:

!mech proximityrange SOURCEID 2

Manual:

A GM-controlled trigger state that does not depend on token movement.

Use:

!mech manualon SOURCEID
!mech manualoff SOURCEID
!mech manualtoggle SOURCEID

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

!mech make NAME [pressurePlate|tripwire|proximity|manual]
!mech add lock
!mech add secret
!mech sourcetype SOURCEID pressurePlate|tripwire|proximity|manual
!mech proximityrange SOURCEID CELLS
!mech manualon SOURCEID
!mech manualoff SOURCEID
!mech manualtoggle SOURCEID
!mech effectui SOURCEID
!mech effecttoggle SOURCEID
!mech effecttype SOURCEID alarm|damage|teleport|reveal|save|status|spawn|none
!mech effecttrigger SOURCEID press|release|both
!mech effectmsg SOURCEID message...
!mech effectdamage SOURCEID XdY
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

TELEPORT

Moves the token(s) on the plate to a saved destination marker.

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
