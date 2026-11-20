"""Drive the real native TUI through a PTY and return the raw screen transcript."""
import argparse, json, os, pty, re, select, signal, subprocess, sys, time

def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", required=True)
    parser.add_argument("--home", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--steps", required=True, help="JSON array of {afterMs, text}")
    parser.add_argument("--total", type=int, default=30000)
    parser.add_argument("--env", default="{}", help="JSON object merged onto the inherited environment")
    parser.add_argument("--model", default="")
    parser.add_argument("--workdir", default="", help="child working directory; defaults to --cwd")
    args = parser.parse_args()

    env = dict(os.environ, PI_CODING_AGENT_DIR=args.profile, HOME=args.home, NO_COLOR="1",
               PI_NOTIFICATIONS="off", TERM="xterm-256color")
    env.update(json.loads(args.env))
    master, slave = pty.openpty()
    proc = subprocess.Popen(
        ["/Users/plaud/.bun/bin/bun", os.path.join(args.cwd, "node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"),
         "--no-session"] + (["--model", args.model] if args.model else []),
        stdin=slave, stdout=slave, stderr=slave, env=env, cwd=args.workdir or args.cwd, close_fds=True)
    os.close(slave)
    steps = json.loads(args.steps)
    buffer = b""
    started = time.time()
    for step in steps:
        deadline = started + step["afterMs"] / 1000.0
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.05)
            if r:
                try: buffer += os.read(master, 65536)
                except OSError: break
        os.write(master, step["text"].encode())
    end = started + args.total / 1000.0
    while time.time() < end:
        r, _, _ = select.select([master], [], [], 0.1)
        if r:
            try: buffer += os.read(master, 65536)
            except OSError: break
    try:
        os.write(master, b"\x03")
        time.sleep(0.3)
    except OSError:
        pass
    proc.terminate()
    try: proc.wait(timeout=5)
    except subprocess.TimeoutExpired: proc.kill()
    text = buffer.decode("utf8", "replace")
    text = re.sub(r"\x1b\][^\x07]*\x07", "", text)
    text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
    print(json.dumps({"screen": text}))
    return 0

sys.exit(main())
