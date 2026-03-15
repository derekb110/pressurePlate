Pressure Plate Doors (Roll20 API)

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

!plate ui

Basic Usage
Create a Plate

Select one or more tokens and run:

!plate make PlateName


Plate tokens are automatically moved to the GM layer.

Bind Doors to a Single Plate

Select:

The plate token (GM layer)

One or more Door Tool doors

Then run:

!plate add lock


or

!plate add secret

Convert a Plate into a Trap

Open the main UI:

!plate ui

Then click the trap button on a plate, or open the trap UI directly:

!plate trapui PLATEID

From the trap UI you can:

Choose a trap type

Choose whether it fires on press, release, or both

Set a trap message

Configure trap-specific settings like damage, save DC, markers, reveal targets, spawn targets, or teleport destination

Optionally enable the lock-token effect

Trap Setup Notes

Teleport traps:

Select one destination marker token/graphic, then use:

!plate trapsetteleport PLATEID

Reveal traps:

Select one or more hidden graphics or secret doors, then use:

!plate trapsetreveal PLATEID

Spawn traps:

Select one or more GM-layer graphics to reveal on trigger, then use:

!plate trapsetspawn PLATEID

Status traps:

Use comma-separated Roll20 status marker names, for example:

!plate trapstatusmarkers PLATEID cobweb,poisoned

Lock token effect:

When enabled, triggered token(s) are snapped back to their locked position until manually unlocked.

Use:

!plate trapunlock PLATEID

Create a Group Puzzle

Select multiple plate tokens:

!plate groupmake PuzzleA 2


This creates a group requiring 2 plates.

Add doors:

!plate groupadddoors PuzzleA lock

Command Reference
!plate ui
!plate setpage
!plate check

!plate make NAME
!plate add lock
!plate add secret
!plate trapui PLATEID
!plate traptoggle PLATEID
!plate traptype PLATEID alarm|damage|teleport|reveal|save|status|spawn|none
!plate traptrigger PLATEID press|release|both
!plate trapmsg PLATEID message...
!plate trapdamage PLATEID XdY
!plate trapsavelabel PLATEID LABEL
!plate trapsavedc PLATEID DC
!plate trapsavesuccessmsg PLATEID message...
!plate trapsavefailmsg PLATEID message...
!plate trapsavesuccessdmg PLATEID XdY
!plate trapsavefaildmg PLATEID XdY
!plate trapstatusmarkers PLATEID marker1,marker2
!plate trapstatusclear PLATEID
!plate trapsetteleport PLATEID
!plate trapclearteleport PLATEID
!plate trapsetreveal PLATEID
!plate trapclearreveal PLATEID
!plate trapsetspawn PLATEID
!plate trapclearspawn PLATEID
!plate traplocktoggle PLATEID
!plate traplockmarker PLATEID MARKER
!plate trapunlock PLATEID
!plate checkplate PLATEID
!plate simopen PLATEID
!plate simclose PLATEID
!plate removeplate PLATEID
!plate ping PLATEID

!plate platemsgon PLATEID message...
!plate platemsgoff PLATEID message...

!plate groupmake NAME [K]
!plate groupaddplates NAME
!plate groupadddoors NAME lock
!plate groupadddoors NAME secret
!plate groupsetall NAME
!plate groupsetk NAME K

!plate grouplock NAME
!plate groupcfglock NAME
!plate groupoverride NAME
!plate groupautolock NAME
!plate groupreset NAME

!plate groupremove NAME
!plate groupdelplate NAME PLATEID
!plate groupdeldor NAME DOORID


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

SAVE

Prompts a save or check with configurable DC, messages, and optional success/fail damage.

STATUS

Applies configurable token markers to triggered token(s), with optional clear on release.

SPAWN

Moves selected GM-layer spawn tokens to the objects layer when triggered.

LOCK TOKEN EFFECT

Optional extra trap effect that holds triggered token(s) in place until manually unlocked.

Examples

Dart trap with save-for-half

!plate traptype PLATEID save
!plate trapsavelabel PLATEID DEX
!plate trapsavedc PLATEID 14
!plate trapsavesuccessdmg PLATEID 1d4
!plate trapsavefaildmg PLATEID 2d4
!plate trapmsg PLATEID A volley of darts fires from the wall.

Web snare trap

!plate traptype PLATEID status
!plate trapstatusmarkers PLATEID cobweb
!plate traplocktoggle PLATEID
!plate trapmsg PLATEID Sticky webbing erupts from the floor.

Ambush spawn trap

!plate traptype PLATEID spawn
!plate trapmsg PLATEID Hidden attackers rush into the room.

Backward Compatibility

Existing pressure plates continue to work without conversion.

Trap configuration is additive and uses backfilled defaults, so older saved plate data should remain valid after script updates.

State Persistence

The script uses a persistent state key:

PPD_CAMPAIGN_CORE


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
