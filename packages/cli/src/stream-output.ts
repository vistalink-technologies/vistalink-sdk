import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Write a web stream with backpressure; file destinations replace atomically on success. */
export async function writeNdjsonStream(
  body: ReadableStream<Uint8Array>,
  out: string | undefined,
  stdout: Writable = process.stdout,
): Promise<number> {
  const destination = out ? resolve(out) : undefined;
  let existingMode: number | undefined;
  if (destination) {
    try {
      const current = await stat(destination);
      if (current.isFile()) existingMode = current.mode & 0o777;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        void body.cancel(error).catch(() => {});
        throw error;
      }
    }
  }

  const temp = destination
    ? join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`)
    : undefined;
  const fileSink = temp
    ? createWriteStream(temp, {
        flags: "wx",
        ...(existingMode === undefined ? {} : { mode: existingMode }),
      })
    : undefined;
  const stdoutSink = fileSink
    ? undefined
    : new Writable({
        write(chunk: Buffer, _encoding, callback) {
          try {
            stdout.write(chunk, callback);
          } catch (error) {
            callback(error instanceof Error ? error : new Error(String(error)));
          }
        },
      });
  const sink = fileSink ?? stdoutSink!;
  const forwardStdoutError = (error: Error): void => {
    stdoutSink?.destroy(error);
  };
  if (stdoutSink) stdout.on("error", forwardStdoutError);

  const decoder = new TextDecoder();
  let lines = 0;
  let partialLineHasText = false;
  const countLines = (text: string): void => {
    let start = 0;
    for (let newline = text.indexOf("\n", start); newline !== -1; newline = text.indexOf("\n", start)) {
      if (partialLineHasText || /\S/u.test(text.slice(start, newline))) lines += 1;
      partialLineHasText = false;
      start = newline + 1;
    }
    if (/\S/u.test(text.slice(start))) partialLineHasText = true;
  };

  const counter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      countLines(decoder.decode(chunk, { stream: true }));
      callback(null, chunk);
    },
    flush(callback) {
      countLines(decoder.decode());
      if (partialLineHasText) lines += 1;
      callback();
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(body as unknown as import("node:stream/web").ReadableStream<Uint8Array>),
      counter,
      sink,
    );
    if (temp && destination) await rename(temp, destination);
    return lines;
  } finally {
    if (stdoutSink) {
      stdout.off("error", forwardStdoutError);
      if (!stdoutSink.destroyed) stdoutSink.destroy();
    }
    if (temp) await rm(temp, { force: true }).catch(() => {});
  }
}
