# Slack Notion Summarizer

A [Notion Worker](https://developers.notion.com/workers/get-started/overview) that reads every public channel in a Slack workspace, summarizes the last N days of activity with Claude, and writes a formatted recap page into a Notion database. A `/summarize` slash command in Slack can trigger it on demand.

## What it does

1. Lists every public Slack channel and auto-joins any the bot hasn't joined yet.
2. Pulls each channel's message history for the requested window (30 days by default), filtering out Slack's own system notices (joins, leaves, topic changes) so dormant channels don't get summarized.
3. Sends each channel's transcript to Claude for a short summary, then generates a one-paragraph overview across all of them.
4. Writes a single Notion page: overview, table of contents, then one heading and summary per channel.

## Requirements

- Node >= 22, npm >= 10.9.2.
- The [`ntn` CLI](https://developers.notion.com/workers/get-started/overview) (`curl -fsSL https://ntn.dev | bash`) and a Notion workspace to deploy the worker into.
- A Notion integration token with access to the target database.
- An [Anthropic API key](https://console.anthropic.com/). Every run makes one Claude call per active channel plus one for the overview, this is a real per-run cost, not a one-time fee.
- A Slack app with a bot token, `channels:read`, `channels:history`, `channels:join`, and `users:read` scopes, installed to the workspace you want to summarize. The `/summarize` slash command additionally needs Socket Mode enabled and an app-level token, see [docs/slack-relay-setup.md](docs/slack-relay-setup.md).

## Setup

### 1. Create the target Notion database

The worker writes to an existing database. It doesn't create one for you. In Notion, create a database with:

- A title property named **Date**.
- Any other properties you want are fine, the worker only writes the title.

Get its data source ID: run `ntn datasources resolve <database-id>` against the database's page ID (find that in the database's URL), or `ntn datasources query <data-source-id>` if you already have it. See the [Notion Workers docs](https://developers.notion.com/workers/get-started/overview) for the full ID-resolution flow.

Optionally, upload a custom emoji to the workspace and note its ID if you want the recap pages to carry a custom icon.

### 2. Configure environment variables

```shell
cp .env.example .env
```

Fill in every value in `.env`. See the comments in `.env.example` for what each one is and where to find it. `NOTION_DATA_SOURCE_ID` is required; `NOTION_CUSTOM_EMOJI_ID` is optional and can stay blank.

### 3. Install and deploy

```shell
npm install
ntn login
ntn workers deploy
ntn workers env push
```

### 4. Run it

```shell
ntn workers exec summarizeSlackChannels -d '{"daysBack": 30}'
```

Or trigger the same tool from a Notion Custom Agent, or set up the Slack `/summarize` slash command, see [docs/slack-relay-setup.md](docs/slack-relay-setup.md) for the full relay setup (Slack app config, `ntn` CLI auth workaround for headless processes, and the optional launchd job for macOS so `/summarize` works without a terminal open).

## Architecture notes

- **Why not a Notion Worker `webhook()` for the slash command**: a webhook capability always acknowledges with a fixed HTTP 202, while Slack requires slash-command endpoints to ack with exactly HTTP 200 within 3 seconds. The two are incompatible, so the slash command runs through a separate Socket Mode relay process instead. Full explanation in [docs/slack-relay-setup.md](docs/slack-relay-setup.md).
- **Why the database isn't worker-managed**: `worker.database()` only creates databases the worker itself owns and writes to through syncs, it can't target a database you already created. This worker writes directly through `context.notion.pages.create()` against an existing data source instead.

## Known limitation

If you set up the Slack relay, it only runs while the machine hosting it is on, awake, and logged in. There's no hosted relay option here, if `/summarize` needs to work with no machine kept running, that's a different, larger build than this template covers.

## License

MIT, see [LICENSE](LICENSE).
