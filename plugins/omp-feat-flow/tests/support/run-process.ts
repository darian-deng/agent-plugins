import { createInterface } from "node:readline";
import { openRun, RunBusyError, type RunContext, type RunInput } from "../../src/run";

const request = JSON.parse(process.argv[2]!) as { context: RunContext; task: string; inputs: RunInput[] };
try {
  const kernel = await openRun(request.context);
  try {
    await kernel.apply({ kind: "task", task: request.task }, request.context.binding);
    for (const input of request.inputs) await kernel.apply(input, request.context.binding);
    console.log(JSON.stringify({ kind: "ready", view: kernel.inspect() }));
    for await (const command of createInterface({ input: process.stdin })) {
      if (command === "release") break;
      if (command === "inspect") console.log(JSON.stringify({ kind: "ready", view: kernel.inspect() }));
    }
  } finally { await kernel.dispose(); }
} catch (error) {
  if (error instanceof RunBusyError) console.log(JSON.stringify({ kind: "busy" }));
  else throw error;
}
