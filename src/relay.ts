import "dotenv/config";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { App } from "@slack/bolt";
import { requiredEnv } from "./env.js";

const execFileAsync = promisify(execFile);

// launchd doesn't inherit your shell PATH, so `ntn` alone often resolves to nothing
// when this relay runs as a background job. Set NTN_BIN to the absolute path from
// `which ntn` if the relay can't find the CLI; defaults to plain "ntn" for local runs.
const NTN_BIN = process.env.NTN_BIN || "ntn";

const SLACK_BOT_TOKEN = requiredEnv("SLACK_BOT_TOKEN");
const SLACK_APP_TOKEN = requiredEnv("SLACK_APP_TOKEN");
const SLACK_ADMIN_USER_ID = requiredEnv("SLACK_ADMIN_USER_ID");

interface SummarizeResult {
	channelsSummarized: number;
	pageUrl: string | null;
}

interface ExecError extends Error {
	stderr?: string;
}

// NOTION_API_TOKEN authenticates as the worker's bot/integration identity, which
// `ntn workers exec` rejects — it needs the personal, file-based `ntn login` session
// instead (see docs/slack-relay-setup.md). Built once so every `ntn` call this relay
// ever makes goes through the same, correct environment.
function ntnExecEnv(): NodeJS.ProcessEnv {
	const { NOTION_API_TOKEN: _unused, ...rest } = process.env;
	return { ...rest, NOTION_KEYRING: "0" };
}

async function runSummarizer(daysBack: number): Promise<SummarizeResult> {
	try {
		const { stdout } = await execFileAsync(
			NTN_BIN,
			["workers", "exec", "summarizeSlackChannels", "-d", JSON.stringify({ daysBack })],
			{ timeout: 25 * 60 * 1000, env: ntnExecEnv() },
		);
		return JSON.parse(stdout) as SummarizeResult;
	} catch (error) {
		const stderr = (error as ExecError).stderr?.trim();
		throw new Error(stderr || (error as Error).message);
	}
}

const app = new App({
	token: SLACK_BOT_TOKEN,
	appToken: SLACK_APP_TOKEN,
	socketMode: true,
});

let running = false;

app.command("/summarize", async ({ command, ack, respond }) => {
	await ack();
	const say = (text: string) => respond({ response_type: "ephemeral", text });

	if (command.user_id !== SLACK_ADMIN_USER_ID) {
		await say("This command is restricted to workspace admins.");
		return;
	}

	const arg = command.text.trim();
	const daysBack = arg ? Number(arg) : 30;
	if (!Number.isInteger(daysBack) || daysBack <= 0) {
		await say("Give a positive whole number of days, for example `/summarize 7`.");
		return;
	}

	if (running) {
		await say("A summary is already running. Try again once it finishes.");
		return;
	}

	running = true;
	await say(`Generating a ${daysBack}-day Slack summary. This can take a few minutes.`);

	try {
		const result = await runSummarizer(daysBack);
		if (result.channelsSummarized === 0) {
			await say(`No active channels in the last ${daysBack} days. Nothing to summarize.`);
			return;
		}
		await say(`Summarized ${result.channelsSummarized} channel(s): ${result.pageUrl}`);
	} catch (error) {
		await say(`Summary failed: ${(error as Error).message}`);
	} finally {
		running = false;
	}
});

await app.start();
console.log("slack-summary-relay: connected via Socket Mode");
