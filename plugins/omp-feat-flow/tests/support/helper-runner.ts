/**
 * Runs one helper job through the same `runHelper` the extension uses, in this isolated child
 * process, and prints the receipt. Only public SDK session creation is used.
 */
import { createAgentSession, SessionManager } from "@oh-my-pi/pi-coding-agent";
import { runHelper, type HelperJob } from "../../src/helpers";

const raw = process.argv[2];
if (!raw) throw new Error("usage: helper-runner.ts '<job json>'");
const job = JSON.parse(raw) as Omit<HelperJob, "model" | "modelRegistry">;
const receipt = await runHelper({ createAgentSession, SessionManager }, job);
console.log(JSON.stringify(receipt));
