#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { CredentialStore } from "./credentials.js";
import { run } from "./program.js";
import { writeNdjsonStream } from "./stream-output.js";

function readStdin(): string {
  return readFileSync(0, "utf8");
}

/** Hidden prompt on a TTY; piped stdin otherwise (`echo $KEY | vistalink login`). */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) return readStdin();
  process.stderr.write(prompt);
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          done();
          return resolve(value);
        }
        if (ch === "\u0003") {
          done();
          return reject(new Error("Interrupted"));
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) process.stderr.write("\b \b");
          value = value.slice(0, -1);
        } else {
          value += ch;
          // One dot per printable character, so a paste visibly landed; the key itself is never echoed.
          if (ch >= " ") process.stderr.write("•");
        }
      }
    };
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    stdin.on("data", onData);
  });
}

const code = await run(process.argv.slice(2), {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
  env: process.env,
  store: CredentialStore.default(process.env),
  readFile: (path) => (path === "-" ? readStdin() : readFileSync(path, "utf8")),
  writeFile: (path, data) => writeFileSync(path, data),
  writeStream: (path, body) => writeNdjsonStream(body, path),
  readSecret,
});
process.exitCode = code;
