import { appendFileSync, existsSync, readFileSync } from "node:fs";

export interface MeterBudget {
	maxRequests: number;
	maxOutputTokens: number;
	maxBodyBytes: number;
}

export interface Meter {
	baseUrl: string;
	requests(): number;
	/** Forwarded requests already counted by earlier runs of this campaign. */
	initial(): number;
	/** Every recovery sentinel seen in a forwarded request body. */
	sentinels(): string[];
	/** Tool names carried by each forwarded request, in order; the wire is the evidence, not the answer. */
	tools(): string[][];
	failures(): string[];
	stop(): void;
}

/**
 * The single inference path for a live case: every provider request goes to this proxy,
 * which forwards to the real upstream only while the campaign budget allows it.
 */
export function startMeter(upstream: string, budget: MeterBudget, logPath: string): Meter {
	// The campaign allowance is cumulative: earlier forwarded requests stay counted across runs.
	const initial = existsSync(logPath) ? readFileSync(logPath, "utf8").split("\n").filter(line => line.trim()).length : 0;
	let count = initial;
	const seenSentinels: string[] = [];
	const seenTools: string[][] = [];
	const failures: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			const index = ++count;
			const record = (fields: Record<string, unknown>) => appendFileSync(logPath, JSON.stringify({ index, ...fields }) + "\n");
			if (request.method !== "POST") {
				failures.push(`unexpected ${request.method} ${url.pathname}`);
				record({ method: request.method, path: url.pathname, status: 405 });
				return new Response("meter: only POST is forwarded", { status: 405 });
			}
			if (index > budget.maxRequests) {
				failures.push(`request ${index} exceeds the ${budget.maxRequests}-request budget`);
				record({ path: url.pathname, status: 429 });
				return new Response("meter: campaign request budget exhausted", { status: 429 });
			}
			const body = await request.text();
			const bytes = Buffer.byteLength(body);
			if (bytes > budget.maxBodyBytes) {
				failures.push(`request ${index} body ${bytes} exceeds ${budget.maxBodyBytes} bytes`);
				record({ path: url.pathname, status: 413, bytes });
				return new Response("meter: request body too large", { status: 413 });
			}
			let parsed: unknown;
			try { parsed = JSON.parse(body); } catch { failures.push(`request ${index} is not JSON`); }
			const maxTokens = parsed !== null && typeof parsed === "object" && "max_tokens" in parsed ? parsed.max_tokens : undefined;
			// Tool names are the isolation evidence; prompt bodies and headers are never retained.
			// Only the plugin's recovery sentinel is retained from a body; nothing else is stored.
			const sentinels = [...body.matchAll(/feat-flow-recovery: [^"\\\n]{0,400}/g)].map(match => match[0]);
			seenSentinels.push(...sentinels);
			const toolNames = parsed !== null && typeof parsed === "object" && "tools" in parsed && Array.isArray(parsed.tools)
				? parsed.tools.flatMap(tool => tool !== null && typeof tool === "object" && "name" in tool && typeof tool.name === "string" ? [tool.name] : [])
				: [];
			if (typeof maxTokens === "number" && maxTokens > budget.maxOutputTokens) {
				failures.push(`request ${index} asks ${maxTokens} output tokens, above ${budget.maxOutputTokens}`);
				record({ path: url.pathname, status: 400, bytes, maxTokens });
				return new Response("meter: max_tokens above the campaign cap", { status: 400 });
			}
			// Forward under the upstream's own authority: the local Host header would route elsewhere.
			const headers = new Headers(request.headers);
			headers.delete("host");
			headers.delete("content-length");
			const target = upstream + url.pathname.slice("/v1".length) + url.search;
			const upstreamResponse = await fetch(target, { method: "POST", headers, body });
			const text = await upstreamResponse.text();
			let usage: unknown;
			try {
				const decoded: unknown = JSON.parse(text);
				if (decoded !== null && typeof decoded === "object" && "usage" in decoded) usage = decoded.usage;
			} catch { /* streaming bodies carry no JSON usage */ }
			seenTools.push(toolNames);
			record({ path: url.pathname, target, status: upstreamResponse.status, bytes, maxTokens, toolNames, sentinels, usage });
			return new Response(text, { status: upstreamResponse.status, headers: upstreamResponse.headers });
		},
	});
	return {
		baseUrl: `http://127.0.0.1:${server.port}/v1`,
		requests: () => count,
		initial: () => initial,
		sentinels: () => [...seenSentinels],
		tools: () => seenTools.map(names => [...names]),
		failures: () => failures,
		stop: () => server.stop(true),
	};
}
