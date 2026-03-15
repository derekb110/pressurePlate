Trigger Mechanisms (Roll20 API)

A full-featured pressure plate and door control system for Roll20.

Supports:

Single plate → multiple doors

K-of-N group plate puzzles

Single plate trap conversion with separate trap config UI

Secret doors and locked doors

Trigger & release messages

Trap types: alarm, damage, teleport, reveal, save, status, spawn

Extra trap effect: lock triggered token(s) in place

Auto-lock puzzles

Mechanism lock & config lock systems

Teleport-style GM UI panel

Ping support

Safe state persistence across script updates

Features
Single Plates

Bind one plate to multiple doors

Supports:

Locked doors (open/unlock when pressed)

Secret doors (reveal/open when pressed)

Optional trigger and release chat messages

Optional trap conversion with a dedicated trap config menu

Groups (K-of-N)

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

Teleport-style plate list

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
Create a Plate

Select one or more tokens and run:

!mech make PlateName


Plate tokens are automatically moved to the GM layer.

Bind Doors to a Single Plate

Select:

The plate token (GM layer)

One or more Door Tool doors

Then run:

!mech add lock


or

!mech add secret

Convert a Plate into a Trap

Open the main UI:

!mech ui

Then click the trap button on a plate, or open the trap UI directly:

!mech trapui PLATEID

From the trap UI you can:

Choose a trap type

Choose whether it fires on press, release, or both

Set a trap message

Configure trap-specific settings like damage, save DC, markers, reveal targets, spawn targets, or teleport destination

Optionally enable the lock-token effect

For non-reveal trap types, you can also enable reveal as an extra effect so a save, damage, or spawn trap can reveal hidden targets at the same time.

Trap Setup Notes

Teleport traps:

Select one destination marker token/graphic, then use:

!mech trapsetteleport PLATEID

Reveal traps:

Select one or more hidden graphics or secret doors, then use:

!mech trapsetreveal PLATEID

Spawn traps:

Select one or more GM-layer graphics to reveal on trigger, then use:

!mech trapsetspawn PLATEID

Status traps:

Use comma-separated Roll20 status marker names, for example:

!mech trapstatusmarkers PLATEID cobweb,poisoned

Lock token effect:

When enabled, triggered token(s) are snapped back to their locked position until manually unlocked.

Use:

!mech trapunlock PLATEID

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

!mech make NAME
!mech add lock
!mech add secret
!mech trapui PLATEID
!mech traptoggle PLATEID
!mech traptype PLATEID alarm|damage|teleport|reveal|save|status|spawn|none
!mech traptrigger PLATEID press|release|both
!mech trapmsg PLATEID message...
!mech trapdamage PLATEID XdY
!mech trapsavelabel PLATEID LABEL
!mech trapsavedc PLATEID DC
!mech trapsavesuccessmsg PLATEID message...
!mech trapsavefailmsg PLATEID message...
!mech trapsavesuccess PLATEID half|none
!mech trapsavedmgtype PLATEID TYPE
!mech trapsavefaildmg PLATEID XdY
!mech trapstatusmarkers PLATEID marker1,marker2
!mech trapstatusclear PLATEID
!mech trapsetteleport PLATEID
!mech trapclearteleport PLATEID
!mech trapsetreveal PLATEID
!mech trapclearreveal PLATEID
!mech traprevealtoggle PLATEID
!mech trapsetspawn PLATEID
!mech trapclearspawn PLATEID
!mech traplocktoggle PLATEID
!mech traplockmarker PLATEID MARKER
!mech trapunlock PLATEID
!mech checkplate PLATEID
!mech simopen PLATEID
!mech simclose PLATEID
!mech removeplate PLATEID
!mech ping PLATEID

!mech platemsgon PLATEID message...
!mech platemsgoff PLATEID message...

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
!mech groupdelplate NAME PLATEID
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

Trap Modes

ALARM

Posts a trap narration message when triggered.

DAMAGE

Posts a damage roll message against the token(s) on the plate.

TELEPORT

Moves the token(s) on the plate to a saved destination marker.

REVEAL

Reveals selected GM-layer graphics or secret doors.

Reveal can also be used as an extra effect on non-reveal trap types.

SAVE

Prompts a save or check with configurable DC, messages, fail damage, damage type, and a success result of either half or none.

STATUS

Applies configurable token markers to triggered token(s), with optional clear on release.

SPAWN

Moves selected GM-layer spawn tokens to the objects layer when triggered.

LOCK TOKEN EFFECT

Optional extra trap effect that holds triggered token(s) in place until manually unlocked.

Examples

Dart trap with save-for-half

!mech traptype PLATEID save
!mech trapsavelabel PLATEID DEX
!mech trapsavedc PLATEID 14
!mech trapsavesuccess PLATEID half
!mech trapsavedmgtype PLATEID piercing
!mech trapsavefaildmg PLATEID 2d4
!mech trapmsg PLATEID A volley of darts fires from the wall.

Reveal-and-save trap

!mech traptype PLATEID save
!mech traprevealtoggle PLATEID
!mech trapsavelabel PLATEID DEX
!mech trapsavedc PLATEID 15
!mech trapsavesuccess PLATEID none
!mech trapsavedmgtype PLATEID fire
!mech trapsavefaildmg PLATEID 3d6
!mech trapmsg PLATEID Flame jets burst from hidden wall vents.

Web snare trap

!mech traptype PLATEID status
!mech trapstatusmarkers PLATEID cobweb
!mech traplocktoggle PLATEID
!mech trapmsg PLATEID Sticky webbing erupts from the floor.

Ambush spawn trap

!mech traptype PLATEID spawn
!mech trapmsg PLATEID Hidden attackers rush into the room.

Backward Compatibility

Existing pressure plates continue to work without conversion.

Trap configuration is additive and uses backfilled defaults, so older saved plate data should remain valid after script updates.

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
