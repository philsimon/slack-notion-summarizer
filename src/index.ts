import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";
import Anthropic from "@anthropic-ai/sdk";
import { requiredEnv } from "./env.js";

const worker = new Worker();
export default worker;

const SLACK_DATA_SOURCE_ID = requiredEnv("NOTION_DATA_SOURCE_ID");
const SLACK_CUSTOM_EMOJI_ID = process.env.NOTION_CUSTOM_EMOJI_ID;

const SUMMARY_STYLE_PROMPT = `Write in active voice only, with short direct sentences under 25 words. Avoid jargon (say "use" not "utilize", "processes" not "workflows") and filler phrases like "in terms of" or "going forward". Don't write consecutive sentences with the same structure, and don't begin a sentence with "What," "Who," "Where," or "Why" unless it's a question. Use the Oxford comma. Write plain paragraphs, no bullet points unless the content is genuinely list-like.`;

interface SlackMessage {
	user?: string;
	text?: string;
	ts: string;
	subtype?: string;
}

const SYSTEM_NOTICE_SUBTYPES = new Set([
	"channel_join",
	"channel_leave",
	"channel_topic",
	"channel_purpose",
	"channel_name",
	"channel_archive",
	"channel_unarchive",
]);

interface SlackChannel {
	id: string;
	name: string;
	is_member: boolean;
	is_archived: boolean;
}

function slackToken(): string {
	return requiredEnv("SLACK_BOT_TOKEN");
}

async function slackApi<T>(
	method: string,
	params: Record<string, string> = {},
): Promise<T> {
	const url = new URL(`https://slack.com/api/${method}`);
	for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
	const res = await fetch(url, {
		headers: { Authorization: `Bearer ${slackToken()}` },
	});
	const body = (await res.json()) as { ok: boolean; error?: string } & T;
	if (!body.ok) throw new Error(`Slack API ${method} failed: ${body.error}`);
	return body;
}

async function listPublicChannels(): Promise<SlackChannel[]> {
	const channels: SlackChannel[] = [];
	let cursor: string | undefined;
	do {
		const params: Record<string, string> = {
			types: "public_channel",
			exclude_archived: "true",
			limit: "200",
		};
		if (cursor) params.cursor = cursor;
		const res = await slackApi<{
			channels: SlackChannel[];
			response_metadata?: { next_cursor?: string };
		}>("conversations.list", params);
		channels.push(...res.channels);
		cursor = res.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return channels;
}

async function joinChannel(channelId: string): Promise<void> {
	await slackApi("conversations.join", { channel: channelId });
}

async function fetchChannelHistory(
	channelId: string,
	oldestTs: string,
): Promise<SlackMessage[]> {
	const messages: SlackMessage[] = [];
	let cursor: string | undefined;
	do {
		const params: Record<string, string> = {
			channel: channelId,
			oldest: oldestTs,
			limit: "200",
		};
		if (cursor) params.cursor = cursor;
		const res = await slackApi<{
			messages: SlackMessage[];
			has_more: boolean;
			response_metadata?: { next_cursor?: string };
		}>("conversations.history", params);
		messages.push(
			...res.messages.filter(
				(m) => m.text && !(m.subtype && SYSTEM_NOTICE_SUBTYPES.has(m.subtype)),
			),
		);
		cursor = res.has_more ? res.response_metadata?.next_cursor : undefined;
	} while (cursor);
	return messages;
}

async function buildUserMap(): Promise<Map<string, string>> {
	const userMap = new Map<string, string>();
	let cursor: string | undefined;
	do {
		const params: Record<string, string> = { limit: "200" };
		if (cursor) params.cursor = cursor;
		const res = await slackApi<{
			members: Array<{ id: string; name: string; real_name?: string }>;
			response_metadata?: { next_cursor?: string };
		}>("users.list", params);
		for (const member of res.members) {
			userMap.set(member.id, member.real_name || member.name);
		}
		cursor = res.response_metadata?.next_cursor || undefined;
	} while (cursor);
	return userMap;
}

function anthropicClient(): Anthropic {
	return new Anthropic({ apiKey: requiredEnv("ANTHROPIC_API_KEY") });
}

async function summarizeChannel(
	client: Anthropic,
	channelName: string,
	transcript: string,
): Promise<string> {
	const response = await client.messages.create({
		model: "claude-opus-5",
		max_tokens: 1024,
		system: SUMMARY_STYLE_PROMPT,
		messages: [
			{
				role: "user",
				content: `Summarize what happened in the #${channelName} Slack channel over the past month, based on this transcript. Cover the main topics, decisions, and any notable events. Write two to four short paragraphs, no headers.\n\nTranscript:\n${transcript}`,
			},
		],
	});
	const textBlock = response.content.find((b) => b.type === "text");
	return textBlock && textBlock.type === "text" ? textBlock.text : "";
}

async function summarizeOverview(
	client: Anthropic,
	channelSummaries: Array<{ name: string; summary: string }>,
): Promise<string> {
	const combined = channelSummaries
		.map((c) => `#${c.name}:\n${c.summary}`)
		.join("\n\n");
	const response = await client.messages.create({
		model: "claude-opus-5",
		max_tokens: 512,
		system: SUMMARY_STYLE_PROMPT,
		messages: [
			{
				role: "user",
				content: `Write a short overview paragraph, no more than 100 words, summarizing the overall activity across these Slack channels this month. This introduces a longer report where each channel gets its own detailed section below.\n\n${combined}`,
			},
		],
	});
	const textBlock = response.content.find((b) => b.type === "text");
	return textBlock && textBlock.type === "text" ? textBlock.text : "";
}

function paragraphBlocks(text: string): Array<Record<string, unknown>> {
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900));
	return chunks.map((chunk) => ({
		object: "block",
		type: "paragraph",
		paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
	}));
}

worker.tool("summarizeSlackChannels", {
	title: "Summarize Slack Channels",
	description:
		"Summarizes activity across all public Slack channels over the past N days and writes the result to the configured Notion database.",
	schema: j.object({
		daysBack: j
			.number()
			.describe("How many days back to summarize. Defaults to 30.")
			.nullable(),
	}),
	execute: async (input, { notion }) => {
		const daysBack = input.daysBack ?? 30;
		const oldestTs = String(Math.floor(Date.now() / 1000) - daysBack * 86400);

		const [channels, userMap] = await Promise.all([
			listPublicChannels(),
			buildUserMap(),
		]);

		const activeChannels: Array<{ name: string; messages: SlackMessage[] }> = [];
		for (const channel of channels) {
			if (!channel.is_member) await joinChannel(channel.id);
			const messages = await fetchChannelHistory(channel.id, oldestTs);
			if (messages.length > 0) {
				activeChannels.push({ name: channel.name, messages });
			}
		}

		if (activeChannels.length === 0) {
			return { channelsSummarized: 0, pageUrl: null };
		}

		const client = anthropicClient();
		const channelSummaries: Array<{ name: string; summary: string }> = [];
		for (const channel of activeChannels) {
			const transcript = channel.messages
				.reverse()
				.map((m) => `${userMap.get(m.user || "") || m.user || "unknown"}: ${m.text}`)
				.join("\n");
			const summary = await summarizeChannel(client, channel.name, transcript);
			channelSummaries.push({ name: channel.name, summary });
		}

		const overview = await summarizeOverview(client, channelSummaries);

		const today = new Date().toISOString().slice(0, 10);
		const children: Array<Record<string, unknown>> = [
			...paragraphBlocks(overview),
			{ object: "block", type: "table_of_contents", table_of_contents: {} },
		];
		for (const channel of channelSummaries) {
			children.push({
				object: "block",
				type: "heading_2",
				heading_2: { rich_text: [{ type: "text", text: { content: `#${channel.name}` } }] },
			});
			children.push(...paragraphBlocks(channel.summary));
		}

		const page = await notion.pages.create({
			parent: { type: "data_source_id", data_source_id: SLACK_DATA_SOURCE_ID },
			...(SLACK_CUSTOM_EMOJI_ID
				? { icon: { type: "custom_emoji", custom_emoji: { id: SLACK_CUSTOM_EMOJI_ID } } }
				: {}),
			properties: {
				Date: { title: [{ text: { content: `Slack Recap — ${today}` } }] },
			},
			children,
		} as unknown as Parameters<typeof notion.pages.create>[0]);

		return { channelsSummarized: channelSummaries.length, pageUrl: (page as { url?: string }).url ?? null };
	},
});
