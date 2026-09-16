#!/usr/bin/env bash
# =============================================================================
# Event Horizon — Proton/Wine prefix setup
#
# Run this on the LINUX side, in your normal terminal. Not inside Wine.
#
# WHAT PROBLEM THIS SOLVES
#   Vortex ships its own 7-Zip (7z.exe + 7z.dll) inside its app directory and
#   uses it to unpack every mod archive. Event Horizon does NOT need it to
#   read a collection any more -- we parse that ourselves -- but Vortex needs
#   it to install the mods inside one. On a Wine/Proton prefix that 7z.exe is
#   frequently unable to start, usually because the Visual C++ runtime it
#   links against is not present in the prefix.
#
#   You do NOT need to install 7-Zip. It is already there. What is missing is
#   the runtime underneath it.
#
# DO YOU EVEN NEED THIS?
#   Probably not. Event Horizon reads collections without 7-Zip at all now, so
#   the only thing that still needs it is Vortex unpacking mod archives — and
#   Event Horizon TESTS that when you load a collection and warns you if it is
#   broken. If it has not warned you, nothing here needs fixing and --apply
#   will change your prefix for no reason. Run it without --apply first; that
#   only looks.
#
# SAFETY
#   By default this only LOOKS and REPORTS. It changes nothing.
#   Pass --apply to actually install runtimes, and it will still tell you
#   exactly what it is about to run and wait for you to type "yes".
#   It never deletes anything, and never touches your game files or mods.
#
# USAGE
#   bash setup-proton.sh                 # report only  (safe, default)
#   bash setup-proton.sh --apply         # install, with confirmation
#   bash setup-proton.sh --apply --yes   # install, no prompt (for scripts)
#   bash setup-proton.sh --prefix /path/to/pfx    # skip prefix auto-detection
#   bash setup-proton.sh --wine /path/to/wine    # skip the runtime prompt
# =============================================================================

set -u

APPLY=no
ASSUME_YES=no
PREFIX_ARG=""
WINE_ARG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=yes ;;
    --yes|-y) ASSUME_YES=yes ;;
    --prefix) shift; PREFIX_ARG="${1:-}" ;;
    --wine) shift; WINE_ARG="${1:-}" ;;
    -h|--help) sed -n '2,31p' "$0"; exit 0 ;;
    *) printf 'Unknown option: %s (try --help)\n' "$1" >&2; exit 2 ;;
  esac
  shift
done

line() { printf '%s\n' "-------------------------------------------------------------"; }
say()  { printf '%s\n' "$*"; }

say "============================================================="
say "Event Horizon — Proton prefix setup"
say "mode: $([ "$APPLY" = yes ] && echo 'APPLY (will make changes)' || echo 'report only (changes nothing)')"
say "============================================================="

# ── 1. Find the prefix Vortex actually runs in ───────────────────────────────
line
say "[1] VORTEX PREFIX"

# Vortex's roaming data dir is the marker: it exists whenever Vortex has run in
# a prefix. Searching for OUR extension instead would miss a prefix where the
# extension failed to install, which is exactly when you need this script.
#
# Depth matters: from drive_c that path is five levels down
# (users/<user>/AppData/Roaming/Vortex). The diagnostic script shipped with a
# limit one level too shallow and reported "not found" every single time.
VORTEX_DIR=""
PREFIX=""

if [ -n "$PREFIX_ARG" ]; then
  PREFIX="$PREFIX_ARG"
  VORTEX_DIR="$(find "$PREFIX/drive_c" -maxdepth 6 -type d -path '*/AppData/Roaming/Vortex' -print -quit 2>/dev/null)"
  if [ -z "$VORTEX_DIR" ]; then
    say "WARNING: no Vortex data dir under the prefix you gave. Continuing anyway."
  fi
else
  for c in \
    "$HOME/.vortex-linux/compatdata/pfx" \
    "$HOME/Games/umu"/* \
    "$HOME/.local/share/umu"* \
    "$HOME/.steam/steam/steamapps/compatdata"/*/pfx \
    "$HOME/.local/share/Steam/steamapps/compatdata"/*/pfx \
    "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/compatdata"/*/pfx \
    "$HOME/.wine" \
    "$HOME/Games"/*/pfx \
    "$HOME/.local/share/lutris/prefixes"/* ; do
    [ -d "$c/drive_c" ] || continue
    v="$(find "$c/drive_c" -maxdepth 6 -type d -path '*/AppData/Roaming/Vortex' -print -quit 2>/dev/null)"
    if [ -n "$v" ]; then PREFIX="$c"; VORTEX_DIR="$v"; break; fi
  done

  if [ -z "$PREFIX" ]; then
    say "not in the usual places — sweeping \$HOME (a moment)"
    # -xdev, because a prefix is never on another filesystem and a sweep that
    # wanders onto an NFS/SMB mount or a backup snapshot can hang for minutes
    # with no output — on the machine of someone already convinced the tool is
    # broken. The pruned directories are the big ones that cannot contain a
    # drive_c: caches and checkouts, not places a prefix hides.
    VORTEX_DIR="$(find "$HOME" -xdev -maxdepth 12 \
      \( -type d \( -name node_modules -o -name .cache -o -name .git \
                    -o -name .npm -o -name .cargo -o -name Trash \) -prune \) -o \
      \( -type d -path '*/AppData/Roaming/Vortex' -print -quit \) 2>/dev/null)"
    [ -n "$VORTEX_DIR" ] && PREFIX="${VORTEX_DIR%%/drive_c/*}"
  fi
fi

if [ -z "$PREFIX" ]; then
  say "RESULT: could not find a Wine prefix containing Vortex."
  say "        Pass it explicitly:  bash setup-proton.sh --prefix /path/to/pfx"
  say "        (the prefix is the directory that CONTAINS drive_c)"
  exit 1
fi

say "prefix:      $PREFIX"
[ -n "$VORTEX_DIR" ] && say "vortex data: $VORTEX_DIR"

# ── 2. Is Vortex's 7-Zip actually there? ─────────────────────────────────────
line
say "[2] VORTEX'S BUNDLED 7-ZIP"

# find exits 0 when it matches nothing, so `find ... || echo none` never fires.
# Capture, then test the capture.
# List them ALL rather than taking the first hit. A tester's run reported
# "C:/Program Files/7-Zip/7z.exe" — a standalone 7-Zip that happened to sort
# first — while the copy Vortex actually loads lives under its own
# resources/app.asar.unpacked. Naming the wrong binary sends the reader to
# check something Vortex never touches.
ALL_SEVENZIP="$(find "$PREFIX/drive_c" -maxdepth 12 -iname '7z.exe' 2>/dev/null)"
# The one that matters is Vortex's own. Match its BUNDLE LAYOUT, not the word
# "vortex": the tester's prefix is literally named ~/.vortex-linux, so every
# path under it contains "vortex" and the standalone 7-Zip was picked as
# "Vortex's" while Vortex's actual copy was listed as an also-ran. `7z-bin`
# and `app.asar` are Electron-bundle markers a standalone install never has.
SEVENZIP="$(printf '%s\n' "$ALL_SEVENZIP" | grep -E '7z-bin|app\.asar' | head -1)"
[ -z "$SEVENZIP" ] && SEVENZIP="$(printf '%s\n' "$ALL_SEVENZIP" | head -1)"

if [ -n "$SEVENZIP" ]; then
  say "vortex's:  $SEVENZIP"
  others="$(printf '%s\n' "$ALL_SEVENZIP" | grep -v -F "$SEVENZIP" | grep -v '^$')"
  if [ -n "$others" ]; then
    say "others:"
    printf '%s\n' "$others" | sed 's/^/  /'
    say "  (a separately installed 7-Zip is not the one Vortex loads)"
  fi
  say "        So 7-Zip is NOT missing. If extraction fails, the runtime it"
  say "        needs is what's absent — which is what this script installs."
else
  say "found:  NONE under this prefix."
  say "        That is unusual: Vortex ships 7z.exe with itself. A reinstall of"
  say "        Vortex inside this prefix is more likely to help than runtimes."
fi

# ── 3. What tool can modify this prefix? ─────────────────────────────────────
line
say "[3] TOOLING"

# A Steam compatdata prefix is keyed by appid and is protontricks' native case.
# A custom prefix (Vortex-on-Linux installers commonly make one under
# ~/.vortex-linux) is not a Steam app at all, so protontricks-by-appid cannot
# address it and winetricks with WINEPREFIX is the general answer.
APPID=""
case "$PREFIX" in
  */steamapps/compatdata/*/pfx)
    APPID="$(printf '%s' "$PREFIX" | sed -n 's#.*/compatdata/\([0-9][0-9]*\)/pfx.*#\1#p')"
    ;;
esac

HAVE_PROTONTRICKS=no
HAVE_WINETRICKS=no
command -v protontricks >/dev/null 2>&1 && HAVE_PROTONTRICKS=yes
command -v winetricks   >/dev/null 2>&1 && HAVE_WINETRICKS=yes
# Flatpak protontricks is common on Arch/Steam Deck and is not on PATH.
FLATPAK_PT=no
if command -v flatpak >/dev/null 2>&1; then
  flatpak list --app 2>/dev/null | grep -qi 'protontricks' && FLATPAK_PT=yes
fi

say "steam appid:  ${APPID:-<not a Steam prefix>}"
say "protontricks: $HAVE_PROTONTRICKS"
say "  (flatpak):  $FLATPAK_PT"
say "winetricks:   $HAVE_WINETRICKS"

# ── 3b. WHICH wine owns this prefix? ─────────────────────────────────────────
#
# This is the step the first version of the script got wrong, and the tester's
# output showed it plainly:
#
#   wine client error:0: version mismatch 856/961.
#
# winetricks uses whatever `wine` is on PATH. A prefix created by Proton is
# owned by PROTON's wine, and the two refuse to talk to each other — so
# winetricks could not read `%AppData%`, never installed anything, and exited
# 1. That is not a runtime problem, it is the wrong runtime.
#
# winetricks honours $WINE and $WINESERVER, so the fix is to find the wine
# that lives with the prefix and point it there. Searched nearest-first: the
# runtime shipped alongside the prefix is the one that made it.
OWNING_WINE=""
OWNING_WINE_HOW=""

# Proton records which build created a prefix, next to the prefix itself.
# Reading it turns "some Proton I found" into "the build this prefix says made
# it" — and where it cannot be read, saying so is better than presenting a
# guess as a fact. The tester's run picked a wine from the LAST-RESORT branch
# and reported it in the same tone as a certainty.
PREFIX_PARENT="$(dirname "$PREFIX")"
PROTON_BUILD=""
for vf in "$PREFIX_PARENT/version" "$PREFIX_PARENT/config_info"; do
  if [ -r "$vf" ]; then
    PROTON_BUILD="$(head -1 "$vf" 2>/dev/null | tr -d '\r')"
    [ -n "$PROTON_BUILD" ] && break
  fi
done

find_owning_wine() {
  # 0. The build the prefix NAMES, if it named one and it is installed. This
  #    is the only branch that is evidence rather than proximity.
  if [ -n "$PROTON_BUILD" ]; then
    for base in \
      "$HOME/.steam/steam/steamapps/common" \
      "$HOME/.local/share/Steam/steamapps/common" ; do
      [ -d "$base" ] || continue
      while IFS= read -r d; do
        [ -x "$d/files/bin/wine" ] && {
          OWNING_WINE="$d/files/bin/wine"
          OWNING_WINE_HOW="matches the build this prefix records ($PROTON_BUILD)"
          return 0
        }
      done <<EOF
$(find "$base" -maxdepth 1 -type d -name "*${PROTON_BUILD}*" 2>/dev/null)
EOF
    done
  fi
  find_owning_wine_by_location
}

# Every wine on the system, not just Steam's.
#
# The first version searched Steam's steamapps/common and little else, which
# is wrong for most of the people this script is for: Proton-GE lives in
# compatibilitytools.d, Lutris keeps its own runners, umu has its own tree,
# and a Vortex-on-Linux installer may ship a runtime beside the prefix. Picking
# "the first Proton I happened to find" out of that lot is a coin flip, and the
# only party who knows which runtime Vortex actually launches with is the
# person running the script.
#
# So: enumerate them all, say where each came from, and ASK.
ALL_WINES=""
find_all_wines() {
  root="${PREFIX%/compatdata/*}"
  [ "$root" = "$PREFIX" ] && root="$(dirname "$PREFIX")"

  {
    # Beside the prefix — a runtime shipped with the Vortex install itself.
    for c in "$root"/files/bin/wine "$root"/dist/bin/wine \
             "$root"/*/files/bin/wine "$root"/*/dist/bin/wine \
             "$root"/../files/bin/wine ; do
      [ -x "$c" ] && printf '%s\tbeside the prefix\n' "$c"
    done
    # Proton-GE and other custom builds. THE gap in the first version: this is
    # where most non-stock Proton lives, and it was not searched at all.
    for base in "$HOME/.steam/root/compatibilitytools.d" \
                "$HOME/.steam/steam/compatibilitytools.d" \
                "$HOME/.local/share/Steam/compatibilitytools.d" \
                "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam/compatibilitytools.d" ; do
      for c in "$base"/*/files/bin/wine "$base"/*/dist/bin/wine ; do
        [ -x "$c" ] && printf '%s\tcustom Proton (compatibilitytools.d)\n' "$c"
      done
    done
    # Stock Steam Proton.
    for base in "$HOME/.steam/steam/steamapps/common" \
                "$HOME/.local/share/Steam/steamapps/common" \
                "$HOME/.var/app/com.valvesoftware.Steam/.local/share/Steam/steamapps/common" ; do
      for c in "$base"/Proton*/files/bin/wine "$base"/Proton*/dist/bin/wine ; do
        [ -x "$c" ] && printf '%s\tSteam Proton\n' "$c"
      done
    done
    # umu.
    for c in "$HOME/.local/share/umu"/*/files/bin/wine ; do
      [ -x "$c" ] && printf '%s\tumu runtime\n' "$c"
    done
    # Lutris runners.
    for c in "$HOME/.local/share/lutris/runners/wine"/*/bin/wine \
             "$HOME/.local/share/lutris/runners/proton"/*/files/bin/wine ; do
      [ -x "$c" ] && printf '%s\tLutris runner\n' "$c"
    done
    # Whatever is on PATH, named so nobody picks it by accident: it is the one
    # that produced "version mismatch" on the tester's Proton prefix.
    w="$(command -v wine 2>/dev/null || true)"
    [ -n "$w" ] && printf '%s\tsystem wine (usually WRONG for a Proton prefix)\n' "$w"
  } | awk '!seen[$0]++'
}

find_owning_wine_by_location() {
  # Preference order when we are NOT asking: beside the prefix beats a custom
  # build beats Steam's. Only used for the default in the prompt, and for
  # --yes runs where there is nobody to ask.
  for want in "beside the prefix" "custom Proton" "umu runtime" "Steam Proton" "Lutris runner"; do
    hit="$(printf '%s\n' "$ALL_WINES" | grep -F "	$want" | head -1)"
    if [ -n "$hit" ]; then
      OWNING_WINE="${hit%%	*}"
      OWNING_WINE_HOW="${hit#*	}"
      case "$want" in
        "beside the prefix") ;;
        *) OWNING_WINE_HOW="$OWNING_WINE_HOW — NOT verified against this prefix" ;;
      esac
      return 0
    fi
  done
  return 1
}
ALL_WINES="$(find_all_wines)"
[ -n "$PROTON_BUILD" ] && say "prefix records: $PROTON_BUILD"

if [ -z "$ALL_WINES" ]; then
  say "wine runtimes: NONE found on this system."
  say "               Without one, winetricks cannot touch a Proton prefix."
elif [ -n "$WINE_ARG" ]; then
  # Explicit beats everything. The user knows which runtime Vortex uses; we
  # only ever guess because we have not asked.
  OWNING_WINE="$WINE_ARG"
  OWNING_WINE_HOW="you passed --wine"
  say "wine:          $OWNING_WINE  (--wine)"
else
  find_owning_wine || true

  say "wine runtimes found on this system:"
  i=0
  printf '%s\n' "$ALL_WINES" | while IFS="	" read -r wpath wsrc; do
    i=$((i + 1))
    mark=" "
    [ "$wpath" = "$OWNING_WINE" ] && mark="*"
    printf '  %s %d) %s\n      %s\n' "$mark" "$i" "$wpath" "$wsrc"
  done
  say "  (* = default if you just press Enter)"

  COUNT="$(printf '%s\n' "$ALL_WINES" | grep -c .)"
  # Only ASK when there is a person there and a real choice to make. --yes and
  # a single candidate both make the prompt noise.
  if [ "$ASSUME_YES" != yes ] && [ "$COUNT" -gt 1 ] && [ -t 0 ]; then
    say ""
    say "Which one does Vortex actually launch with? This script cannot tell:"
    say "the prefix does not record it reliably, and picking the wrong build"
    say "gives 'version mismatch' and installs nothing."
    printf 'Number, or Enter for the default: '
    read -r pick || pick=""
    if [ -n "$pick" ]; then
      chosen="$(printf '%s\n' "$ALL_WINES" | sed -n "${pick}p")"
      if [ -n "$chosen" ]; then
        OWNING_WINE="${chosen%%	*}"
        OWNING_WINE_HOW="you chose it (${chosen#*	})"
      else
        say "  '$pick' is not one of the numbers above — keeping the default."
      fi
    fi
  fi

  if [ -n "$OWNING_WINE" ]; then
    say ""
    say "using wine:    $OWNING_WINE"
    say "               ($OWNING_WINE_HOW)"
    case "$OWNING_WINE_HOW" in
      *NOT\ verified*)
        say ""
        say "  This was NOT verified against your prefix. If it is the wrong"
        say "  build you get 'version mismatch' and nothing is installed."
        say "  Re-run with the right one:  bash setup-proton.sh --wine /path/to/wine"
        ;;
    esac
  fi
fi

# ── 3c. Does 7-Zip start, and can it LIST? ───────────────────────────────────
#
# TWO different failures wear the same error, and only ONE of them is the thing
# the runtime below fixes:
#
#   cannot start        — 7z.exe will not launch, usually the missing VC++
#                         runtime. This is the case this script was written for
#                         and vcrun2022 is the answer.
#   starts, cannot list — the process runs and exits cleanly, but its listing
#                         output never arrives. Installing runtimes changes
#                         NOTHING here, because nothing is missing.
#
# The second is real and was measured on a player's prefix: 29 listing attempts
# since August, zero successes, while mods installed perfectly — because
# installing is extraction, and only listing was broken. Event Horizon reports
# that as "list-unavailable". Without this test the script diagnoses every such
# prefix as the first case and sends the user after a runtime they already have,
# which is exactly what happened to one tester.
line
say "[3c] 7-ZIP ROUND TRIP"

SEVENZIP_VERDICT="untested"
sevenzip_roundtrip() {
  # Needs a binary AND a wine that owns the prefix. Missing either means there
  # is nothing to test, and saying "untested" beats inventing a verdict.
  [ -n "$SEVENZIP" ]    || { SEVENZIP_VERDICT="no-binary"; return 0; }
  [ -n "$OWNING_WINE" ] || { SEVENZIP_VERDICT="no-wine";   return 0; }

  t="$(mktemp -d 2>/dev/null || printf '/tmp/eh-7z-%s' "$$")"
  mkdir -p "$t" 2>/dev/null || { SEVENZIP_VERDICT="untested"; return 0; }
  printf 'event horizon probe\n' > "$t/probe.txt" 2>/dev/null || {
    SEVENZIP_VERDICT="untested"; rm -rf "$t"; return 0; }

  # Quiet on purpose: wine is noisy on stderr even when it works, and this is a
  # diagnostic rather than something the user is meant to read.
  if ! WINEPREFIX="$PREFIX" "$OWNING_WINE" "$SEVENZIP" a "$t/probe.zip" "$t/probe.txt" \
        >"$t/add.log" 2>&1 || [ ! -s "$t/probe.zip" ]; then
    SEVENZIP_VERDICT="cannot-start"
    rm -rf "$t"
    return 0
  fi

  # Exit status alone is not enough: the failure being hunted here is an empty
  # LISTING from a process that exited fine, so the probe file must appear in
  # the output for this to count as working.
  if WINEPREFIX="$PREFIX" "$OWNING_WINE" "$SEVENZIP" l "$t/probe.zip" \
       >"$t/list.log" 2>&1 && grep -q 'probe\.txt' "$t/list.log"; then
    SEVENZIP_VERDICT="ok"
  else
    SEVENZIP_VERDICT="list-broken"
  fi
  rm -rf "$t"
  return 0
}

sevenzip_roundtrip
case "$SEVENZIP_VERDICT" in
  ok)
    say "result: 7-Zip creates AND lists archives in this prefix. It works."
    say ""
    say "        Nothing below will improve anything. If Event Horizon still"
    say "        warns, send it the log rather than installing runtimes."
    ;;
  list-broken)
    say "result: 7-Zip RUNS but cannot LIST."
    say ""
    say "        It created an archive and then could not read it back. The"
    say "        process starts, so no runtime is missing — vcrun2022 will not"
    say "        change this, and installing it is not the fix."
    say ""
    say "        Mods will still INSTALL: unpacking is extraction, and that"
    say "        works. What Event Horizon loses is checking whether a .rar or"
    say "        .7z you supplied yourself is intact, and it will say so rather"
    say "        than call your file damaged."
    say ""
    say "        Worth trying, in order:"
    say "          - a different Proton build for this prefix (Experimental vs"
    say "            a GE build); they differ in what they can run, and this is"
    say "            the most common cause when 7-Zip runs but misbehaves"
    say "          - re-running with --wine pointing at the runtime Vortex"
    say "            actually launches with, if the one above was a guess"
    ;;
  cannot-start)
    say "result: 7-Zip will NOT start in this prefix."
    say "        This is the case the runtime below is for."
    ;;
  no-binary)  say "result: not tested — no 7z.exe was found under this prefix." ;;
  no-wine)    say "result: not tested — no wine was found to run it with." ;;
  *)          say "result: not tested." ;;
esac

# Decide the command.
#
# An ARRAY, not a string. The runtime that turned up on the tester's machine
# was ".../Proton - Experimental/files/bin/wine", and a string runner is
# word-split on execution: that path becomes "WINE=.../Proton", a bare "-",
# and "Experimental/...", which fails in a way that looks like anything but a
# quoting bug. Spaces in Proton build names are the norm, not the exception.
RUNNER_CMD=()
RUNNER_DESC=""
if [ -n "$APPID" ] && [ "$HAVE_PROTONTRICKS" = yes ]; then
  # protontricks finds the right Proton for a Steam app itself. Preferred
  # precisely because it does not have the problem above.
  RUNNER_CMD=(protontricks "$APPID")
  RUNNER_DESC="protontricks, addressing the Steam app by id"
elif [ -n "$APPID" ] && [ "$FLATPAK_PT" = yes ]; then
  RUNNER_CMD=(flatpak run com.github.Matoking.protontricks "$APPID")
  RUNNER_DESC="protontricks via flatpak"
elif [ "$HAVE_WINETRICKS" = yes ] && [ -n "$OWNING_WINE" ]; then
  RUNNER_CMD=(env "WINEPREFIX=$PREFIX" "WINE=$OWNING_WINE" \
    "WINESERVER=$(dirname "$OWNING_WINE")/wineserver" winetricks)
  RUNNER_DESC="winetricks driven by the prefix's OWN wine (not the one on PATH)"
elif [ "$HAVE_WINETRICKS" = yes ]; then
  RUNNER_CMD=(env "WINEPREFIX=$PREFIX" winetricks)
  RUNNER_DESC="winetricks with the system wine — EXPECTED TO FAIL on a Proton prefix"
fi

# Shell-quote for DISPLAY. The printed command is copy-pasted by hand at least
# as often as --apply is used, so an unquoted one is the same bug twice.
shq() {
  for a in "$@"; do
    case "$a" in
      *[!A-Za-z0-9=/._-]*) printf "'%s' " "$(printf '%s' "$a" | sed "s/'/'\\\\''/g")" ;;
      *) printf '%s ' "$a" ;;
    esac
  done
}

# The runtimes worth installing, most likely first. 7-Zip itself is NOT here:
# Vortex ships it, and installing another copy would not change which binary
# Vortex loads.
VERBS="vcrun2022"

if [ ${#RUNNER_CMD[@]} -eq 0 ]; then
  line
  say "NOTHING TO RUN: neither protontricks nor winetricks is installed."
  say ""
  say "Install one, then re-run this script:"
  say "  Arch/EndeavourOS:  sudo pacman -S winetricks   (or: yay -S protontricks)"
  say "  Fedora:            sudo dnf install winetricks"
  say "  Debian/Ubuntu:     sudo apt install winetricks"
  say "  Flatpak (any):     flatpak install com.github.Matoking.protontricks"
  exit 1
fi

# ── 4. The plan ──────────────────────────────────────────────────────────────
line
say "[4] PLAN"
say "using:   $RUNNER_DESC"
say "command: $(shq "${RUNNER_CMD[@]}" $VERBS)"
say ""
say "This installs the Visual C++ runtime into the Vortex prefix only."
say "It does not touch your games, your mods, or anything outside that prefix."
say "It does not remove or overwrite anything you installed yourself."

if [ "$APPLY" != yes ]; then
  line
  say "REPORT ONLY — nothing was changed."
  say "To actually run the command above:"
  say "  bash setup-proton.sh --apply"
  exit 0
fi

# ── 5. Consent, then do it ───────────────────────────────────────────────────
line
if [ "$ASSUME_YES" != yes ]; then
  printf 'Run the command above? Type yes to continue: '
  read -r reply || reply=""
  case "$reply" in
    yes|YES|y|Y) ;;
    *) say "Aborted. Nothing was changed."; exit 0 ;;
  esac
fi

say "running: $(shq "${RUNNER_CMD[@]}" $VERBS)"
# Captured as well as shown, so the specific failures below can be recognised
# rather than reported as a bare exit code. `tee` keeps the live output.
RUN_LOG="$(mktemp 2>/dev/null || printf '/tmp/eh-setup-%s.log' "$$")"
# The status of a PIPELINE is its LAST command's -- here `tee`, which always
# succeeds. Testing it directly reported DONE for a run that installed
# nothing, which is worse than the bare exit code this replaced. PIPESTATUS
# holds the real one and is clobbered by the very next command, so it must be
# read on the line immediately after the pipeline and nowhere later.
# shellcheck disable=SC2086
"${RUNNER_CMD[@]}" $VERBS 2>&1 | tee "$RUN_LOG"
RC="${PIPESTATUS[0]}"

line
if [ "$RC" = 0 ]; then
  # A zero exit means the installer finished, NOT that 7-Zip works now. Saying
  # "DONE" on that alone is the same assert-instead-of-verify that had Event
  # Horizon telling players their archives were damaged: a claim about a thing
  # nobody re-tested. So re-run the round trip and report what it actually says.
  say "Installed. Re-testing 7-Zip in the prefix…"
  sevenzip_roundtrip
  case "$SEVENZIP_VERDICT" in
    ok)
      say "VERIFIED: 7-Zip now creates and lists archives in this prefix."
      say "Restart Vortex and try the install again."
      ;;
    list-broken)
      say "PARTLY FIXED: 7-Zip starts, but still cannot list."
      say "The runtime went in and it did not change this, which means the"
      say "runtime was never what was missing. Try a different Proton build for"
      say "this prefix. Mods will still install; see [3c] above for what is lost."
      ;;
    cannot-start)
      say "STILL BROKEN: 7-Zip will not start even after installing the runtime."
      say "Paste the output above along with:  bash scripts/diagnose-install.sh"
      ;;
    *)
      say "Could not re-test ($SEVENZIP_VERDICT)."
      say "Restart Vortex; Event Horizon checks the extractor when you load a"
      say "collection and will tell you if it still is not working."
      ;;
  esac
elif grep -qiE 'version mismatch|wineserver binary was not upgraded' "$RUN_LOG" 2>/dev/null; then
  # The one failure that is NOT ambiguous, and the one a tester actually hit.
  # Calling it "not necessarily fatal" wasted their time: nothing was
  # installed and nothing was going to be.
  say "NOTHING WAS INSTALLED — wrong wine for this prefix."
  say ""
  say "  wine client error: version mismatch"
  say ""
  say "The wine that ran is not the one that owns this prefix, so it could not"
  say "open it at all. This is not a problem with your prefix or with 7-Zip."
  if [ -z "$OWNING_WINE" ]; then
    say ""
    say "This script could not find the wine that Vortex uses. Find it with:"
    say "  find \"\$HOME/.vortex-linux\" -name wine -type f -perm -u+x 2>/dev/null"
    say "then re-run pointing at it:"
    say "  WINE=/path/to/wine WINESERVER=/path/to/wineserver \\"
    say "    WINEPREFIX=\"$PREFIX\" winetricks vcrun2022"
  else
    say ""
    say "It used: $OWNING_WINE"
    say "If that is not the runtime Vortex launches with, pass the right one:"
    say "  WINE=/path/to/wine WINESERVER=/path/to/wineserver \\"
    say "    WINEPREFIX=\"$PREFIX\" winetricks vcrun2022"
  fi
  say ""
  say "Worth checking first: you may not need this at all. Event Horizon only"
  say "needs Vortex's 7-Zip for unpacking mods, and it tells you on load if"
  say "that is broken. If it has not warned you, nothing here needs fixing."
else
  say "The command exited with status $RC."
  say ""
  say "That is not necessarily fatal — winetricks reports non-zero for several"
  say "harmless reasons. Restart Vortex and try the install; if Event Horizon"
  say "still warns about the extractor, paste the output above along with:"
  say "  bash scripts/diagnose-install.sh"
fi
