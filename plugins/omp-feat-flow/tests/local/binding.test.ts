import { expect, test } from "bun:test";
import { captureTools, validateBinding } from "../../src/binding";

test("the exact captured tool is required, and a vanished server blocks", () => {
	const captured = captureTools(["read", "mcp__linear_get_issue", "mcp__linear_update_issue"]);
	const expectation = { server: "linear", tool: "get_issue" };
	expect(validateBinding(captured, captured.names, expectation)).toMatchObject({ ok: true });

	const gone = validateBinding(captured, ["read", "mcp__linear_update_issue"], expectation);
	expect(gone.ok).toBe(false);
	expect(gone.blockers.join(" ")).toContain("not active now");

	const substituted = validateBinding(captured, ["read", "mcp__other_get_issue"], expectation);
	expect(substituted.ok).toBe(false);
});

test("a tool set captured after tampering is detected", () => {
	const captured = captureTools(["mcp__linear_get_issue"]);
	captured.names.push("mcp__linear_update_issue");
	expect(validateBinding(captured, captured.names, { server: "linear", tool: "get_issue" }).blockers)
		.toContain("the captured tool set was altered after capture");
});
