import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { writeNdjsonStream } from "../src/stream-output.js";

describe("streaming NDJSON output", () => {
  it("honors destination backpressure before writing the next chunk", async () => {
    let release!: () => void;
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new TextEncoder().encode("first\n"));
        else if (pulls === 2) controller.enqueue(new TextEncoder().encode("second\n"));
        else controller.close();
      },
    }, { highWaterMark: 0 });
    const output: Uint8Array[] = [];
    let writes = 0;
    const sink = new Writable({
      highWaterMark: 1,
      write(chunk, _encoding, callback) {
        output.push(new Uint8Array(chunk));
        if (writes++ === 0) release = callback;
        else callback();
      },
    });
    const writing = writeNdjsonStream(body, undefined, sink);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(writes).toBe(1);
    expect(output).toHaveLength(1);
    release();
    const lines = await writing;
    expect(lines).toBe(2);
    expect(new TextDecoder().decode(Buffer.concat(output))).toBe("first\nsecond\n");
    sink.destroy();
  });

  it("rejects an invalid destination promptly and cancels a blocked source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vistalink-stream-output-"));
    let cancelSource!: () => void;
    let canceled = false;
    const blocked = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>((resolve) => { cancelSource = resolve; });
      },
      cancel() {
        canceled = true;
        cancelSource?.();
      },
    }, { highWaterMark: 0 });

    const operation = writeNdjsonStream(blocked, join(dir, "missing", "rates.ndjson"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await expect(Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("destination error did not settle promptly")), 1_000);
        }),
      ])).rejects.toThrow();
      expect(canceled).toBe(true);
    } finally {
      if (timer) clearTimeout(timer);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("cancels an already-fetched body when destination preflight fails", async () => {
    let canceled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        canceled = true;
      },
    });

    await expect(writeNdjsonStream(body, "bad\0path")).rejects.toMatchObject({ code: "ERR_INVALID_ARG_VALUE" });
    expect(canceled).toBe(true);
  });

  it("handles an asynchronous stdout write error after accepting the chunk", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"hotel_id":"h1"}\n'));
        controller.close();
      },
    });
    const sink = new Writable({
      highWaterMark: 1024,
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(new Error("EPIPE")), 0);
      },
    });
    const errors: Error[] = [];
    const writeResults: boolean[] = [];
    const originalWrite = sink.write.bind(sink);
    sink.write = ((chunk: Uint8Array, encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void) => {
      const result = originalWrite(chunk, encodingOrCallback as BufferEncoding, callback);
      writeResults.push(result);
      return result;
    }) as typeof sink.write;
    sink.on("error", (error: Error) => errors.push(error));

    expect(sink.writableHighWaterMark).toBeGreaterThan(Buffer.byteLength('{"hotel_id":"h1"}\n'));
    await expect(writeNdjsonStream(body, undefined, sink)).rejects.toThrow("EPIPE");
    expect(writeResults[0]).toBe(true);
    expect(errors.map((error) => error.message)).toContain("EPIPE");
  });

  it("replaces files only after a complete download and preserves the old file on errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vistalink-stream-output-"));
    const path = join(dir, "rates.ndjson");
    try {
      await writeFile(path, "previous\n");
      const failed = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"hotel_id":"h1"}\n'));
          controller.error(new Error("truncated download"));
        },
      });
      await expect(writeNdjsonStream(failed, path)).rejects.toThrow("truncated download");
      expect(await readFile(path, "utf8")).toBe("previous\n");
      expect(await readdir(dir)).toEqual(["rates.ndjson"]);

      const complete = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"hotel_id":"h1"}\n'));
          controller.enqueue(new TextEncoder().encode('{"hotel_id":"h2"}\n'));
          controller.close();
        },
      });
      expect(await writeNdjsonStream(complete, path)).toBe(2);
      expect(await readFile(path, "utf8")).toBe('{"hotel_id":"h1"}\n{"hotel_id":"h2"}\n');
      expect(await readdir(dir)).toEqual(["rates.ndjson"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
