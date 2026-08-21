# Slack Slash Command Relay

`/summarize` in Slack triggers the deployed `summarizeSlackChannels` worker tool. Slack can't call the Notion Worker directly (see "Why not a webhook" below), so a small persistent relay process (`src/relay.ts`) holds a Socket Mode connection to Slack, listens for the slash command, and shells out to `ntn workers exec summarizeSlackChannels`.

## One-time Slack app setup

These steps can only be done through the Slack app management dashboard. There's no API for them.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and open the app tied to this workspace's `SLACK_BOT_TOKEN`.
2. **Socket Mode** — under Settings, turn Socket Mode on.
3. **App-Level Token** — still under Socket Mode settings, generate a token with the `connections:write` scope. Copy the value (starts with `xapp-`) into this repo's `.env` as `SLACK_APP_TOKEN`.
4. **Slash Commands** — under Features, create a new command:
   - Command: `/summarize`
   - Request URL: leave blank (not used with Socket Mode)
   - Short description: "Summarize recent Slack activity into Notion"
   - Usage hint: `[days]`
5. **Reinstall the app** to the workspace so it picks up the new slash command.
6. Find your own Slack user ID (profile → More → Copy member ID, or `Slack Admin` in the member's profile) and set it as `SLACK_ADMIN_USER_ID` in `.env`. The relay only runs the summarizer for this user; everyone else gets a polite denial.

## One-time ntn CLI auth setup

`ntn workers exec` needs your personal `ntn login` session, not just the `NOTION_API_TOKEN` integration token in `.env`. By default that session lives only in the macOS Keychain, which a launchd background process can't reach — it fails with `unauthorized`. The relay works around this by shelling out with `NOTION_KEYRING=0`, which tells the CLI to use a file-based session (`~/.config/notion/auth.json`) instead. That file has to exist first:

```shell
NOTION_KEYRING=0 ntn login
```

Run this once, interactively, in your own terminal — it opens a browser to confirm. After that, the relay's `ntn workers exec` calls can authenticate without needing Keychain access.

## Running the relay

```shell
cd /path/to/slack-notion-summarizer
npm run relay
```

This runs `src/relay.ts` directly with `tsx`, loading `.env` automatically. Leave it running to keep the slash command live, or install the launchd job below so it starts on login and stays up.

## launchd job (macOS only)

Copy `launchd/com.example.slack-notion-summarizer-relay.plist` to `~/Library/LaunchAgents/`, then replace every `/absolute/path/to/...` placeholder with your actual clone path (`pwd` from inside the repo gives you this). It runs `run-relay.sh` with `RunAtLoad` and `KeepAlive`, so it restarts if it crashes and starts again on login. Load it once `.env` has real values for `SLACK_APP_TOKEN` and `SLACK_ADMIN_USER_ID`, otherwise it crash-loops:

```shell
cp launchd/com.example.slack-notion-summarizer-relay.plist ~/Library/LaunchAgents/
# edit the copy: replace /absolute/path/to/... with your real paths
launchctl load ~/Library/LaunchAgents/com.example.slack-notion-summarizer-relay.plist
```

Logs land wherever you set `StandardOutPath` / `StandardErrorPath` in the plist.

To stop it:

```shell
launchctl unload ~/Library/LaunchAgents/com.example.slack-notion-summarizer-relay.plist
```

**If the relay crash-loops with "command not found"**: launchd runs jobs with a minimal PATH, not your shell's PATH. It won't find `node` or `ntn` if they live somewhere non-standard (a version manager like `nvm`, for example). Run `which node` and `which ntn` in your normal terminal, then either symlink both into `/usr/local/bin` or `/opt/homebrew/bin`, or edit `run-relay.sh` and set `NTN_BIN` in `.env` to the absolute paths you found.

## Why not a webhook

A Notion Worker `webhook()` capability always acks with a fixed HTTP 202. Slack requires slash-command endpoints to ack with exactly HTTP 200 within 3 seconds. The two are incompatible, so a webhook can never serve a Slack slash command directly — Socket Mode (a persistent, authenticated websocket connection) is the only path.

## Known limitation

The relay only runs while this Mac is on, awake, and logged in. If the Mac is asleep or off, `/summarize` gets no response in Slack.
