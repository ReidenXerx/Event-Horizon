# Let an AI do your modding

Event Horizon can connect an AI assistant to Vortex. You tell it what you want, in plain words, and it does the work in
Vortex: installing mods and answering their installers, switching things on and off, fixing load order and file
conflicts, and reading crash logs to find out why the game will not start.

You do not need to know what a FOMOD, a master or a load order is. It does, and it explains what it is doing as it goes.

## Set it up (two minutes)

1. **Install an AI app.** [Claude Desktop](https://claude.ai/download) is the easiest. Claude Code works too.
2. **Open Vortex → Event Horizon → Agents** and click **Turn on**.
3. **Connect it:**
   - **Claude Desktop:** click **Add Event Horizon to Claude Desktop**, then quit Claude Desktop completely (from the
     tray icon too) and open it again.
   - **Claude Code:** click **Copy command** and paste it once into a terminal.
   - **Any other app that supports MCP:** click **Other MCP apps** for the setup to paste.

That's it. Nothing else to install: the connector runs on Vortex itself.

## Then just ask

Some things people ask:

- *"Install the Unofficial Fallout 4 Patch and pick the right options for my setup."*
- *"My game crashes when I load a save. Find out why and fix it."*
- *"Why is this mod not showing up in game?"*
- *"Make this texture mod win over the other one."*
- *"Turn off every mod that changes the body, I want to test without them."*
- *"What did I install this week?"*

Keep Vortex open while you talk to it. Close the game before asking for changes: it will not touch the game folder
while the game is running, and it will tell you so.

## What it can do

| You say | It does |
| --- | --- |
| "Install …" | Downloads from Nexus, reads the mod's installer **before** installing, picks options that fit your game and your other mods (it checks which options would need mods you don't have), installs, deploys. |
| "It crashes / it won't start" | Reads the newest crash log and your script extender's log, finds the mod or plugin named in it, explains it simply, and proposes a fix. |
| "X should win over Y" | Settles the file conflict with a rule, or fixes the plugin order with a LOOT rule that survives sorting. |
| "Turn off / turn on / remove …" | Finds the mods by name and does it. It asks before removing anything. |
| "My load order is gone" | Restores the last good plugin list Event Horizon saved. |

## What keeps it safe

- **It works only on your PC.** It needs a secret key that changes every time Vortex starts, and it refuses web pages.
- **Nothing is claimed that wasn't checked.** Every change is read back from Vortex before it is reported as done.
- **It never works under a running game**, and never moves a game folder that still has mods in it.
- **It asks before deleting.** Removing mods, purging, and moving the game are always put to you first.
- **You can watch.** Every change appears on the **Agents** page as it happens, with what was checked. Vortex shows a
  notification for each one too.
- **You can switch it off** at any time on the Agents page.

## For the technically curious

The AI talks to Event Horizon through a small MCP server that ships inside the extension
(`dist/mcp/server.js`, plain JavaScript run by Vortex's own executable). It calls the local control channel described
in [`control-channel.md`](control-channel.md), which any script can use directly.
