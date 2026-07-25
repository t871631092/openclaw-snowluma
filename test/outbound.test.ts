import { describe, expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import type { SnowLumaApiClient } from "@snowluma/sdk";

import { chunkText, formatTarget, parseTarget, reactToMessage, sendMedia, sendText } from "../src/outbound.js";

// The outbound tests must never open a real socket, so the client is a hand-written
// object recording calls rather than a real SnowLumaWebSocketClient instance.
function makeFakeClient(overrides: Partial<Record<keyof SnowLumaApiClient, unknown>> = {}) {
  let nextMessageId = 1;
  const calls: { method: string; args: unknown[] }[] = [];

  const record = (method: string, args: unknown[]) => calls.push({ method, args });

  const fake = {
    sendGroupMessage: vi.fn(async (...args: unknown[]) => {
      record("sendGroupMessage", args);
      return { message_id: nextMessageId++ };
    }),
    sendPrivateMessage: vi.fn(async (...args: unknown[]) => {
      record("sendPrivateMessage", args);
      return { message_id: nextMessageId++ };
    }),
    raw: vi.fn(async (...args: unknown[]) => {
      record("raw", args);
      return { file_id: "file-abc" };
    }),
    setMsgEmojiLike: vi.fn(async (...args: unknown[]) => {
      record("setMsgEmojiLike", args);
      return null;
    }),
    ...overrides,
  };

  return { client: fake as unknown as SnowLumaApiClient, calls, raw: fake };
}

// ── parseTarget / formatTarget ──────────────────────────────────────────────

describe("parseTarget", () => {
  it("parses the fully-qualified channel-prefixed group form", () => {
    expect(parseTarget("snowluma:group:1")).toEqual({ kind: "group", id: 1 });
  });

  it("parses the bare group form", () => {
    expect(parseTarget("group:1")).toEqual({ kind: "group", id: 1 });
  });

  it("parses the bare private form", () => {
    expect(parseTarget("private:2")).toEqual({ kind: "private", id: 2 });
  });

  it("parses a channel-prefixed bare id as private", () => {
    expect(parseTarget("snowluma:2")).toEqual({ kind: "private", id: 2 });
  });

  it("parses a bare numeric id as private", () => {
    expect(parseTarget("12345")).toEqual({ kind: "private", id: 12345 });
  });

  it("throws on an empty target", () => {
    expect(() => parseTarget("")).toThrow(/Invalid SnowLuma target/);
  });

  it("throws on an unknown kind", () => {
    expect(() => parseTarget("channel:1")).toThrow(/unknown kind/);
  });

  it("throws on a non-numeric id", () => {
    expect(() => parseTarget("group:abc")).toThrow(/not numeric/);
  });

  it("throws on a malformed target with too many segments", () => {
    expect(() => parseTarget("group:1:extra")).toThrow(/Invalid SnowLuma target/);
  });
});

describe("formatTarget", () => {
  it("renders the channel-prefixed canonical form", () => {
    expect(formatTarget({ kind: "group", id: 1 })).toBe("snowluma:group:1");
    expect(formatTarget({ kind: "private", id: 2 })).toBe("snowluma:private:2");
  });
});

// ── chunkText ────────────────────────────────────────────────────────────

describe("chunkText", () => {
  it("returns [] for empty input", () => {
    expect(chunkText("", 10)).toEqual([]);
  });

  it("returns [] for whitespace-only input", () => {
    expect(chunkText("   \n\t  ", 10)).toEqual([]);
  });

  it("returns the text unchanged as a single chunk when it fits", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  it("keeps multi-line text that fits within the limit as a single chunk", () => {
    // Regression: a message shorter than the limit must never be split just
    // because it contains newlines. Previously the newline preference fired even
    // when the whole text fit, scattering one reply across several QQ sends.
    expect(chunkText("world\nfoo", 100)).toEqual(["world\nfoo"]);

    const multiline = "第一段\n\n第二段\n\n第三段";
    expect(chunkText(multiline, 4500)).toEqual([multiline]);
  });

  it("prefers splitting on the newline nearest the limit, then keeps the fitting remainder whole", () => {
    // Text longer than the limit *must* break: it breaks at the newline nearest
    // the limit ("hello\n"), and the remaining "world\nfoo" fits so stays intact.
    const result = chunkText("hello\nworld\nfoo", 10);
    expect(result).toEqual(["hello\n", "world\nfoo"]);
    expect(result.join("")).toBe("hello\nworld\nfoo");
  });

  it("falls back to a hard split at the limit when there is no newline", () => {
    const result = chunkText("aaaaaaaaaa", 4);
    expect(result).toEqual(["aaaa", "aaaa", "aa"]);
    expect(result.join("")).toBe("aaaaaaaaaa");
  });

  it("never splits inside a [CQ:...] code, even when that forces an oversized chunk", () => {
    const cq = "[CQ:image,file=x]";
    const input = `abc${cq}def`;
    const result = chunkText(input, 10);

    expect(result.join("")).toBe(input);
    for (const chunk of result) {
      // Every CQ code that appears in a chunk must appear in full.
      const opens = (chunk.match(/\[CQ:/g) ?? []).length;
      const closes = (chunk.match(/\]/g) ?? []).length;
      expect(opens).toBe(closes);
    }
    expect(result).toContain(cq);
  });

  it("keeps a CQ code intact when it straddles a newline-preferred boundary", () => {
    const cq = "[CQ:record,file=y]";
    const input = `x\n${cq}\nz`;
    const result = chunkText(input, 5);
    expect(result.join("")).toBe(input);
    expect(result.some((chunk) => chunk.includes(cq))).toBe(true);
  });

  it("throws on a non-positive limit", () => {
    expect(() => chunkText("hello", 0)).toThrow();
    expect(() => chunkText("hello", -1)).toThrow();
  });
});

// ── sendText ─────────────────────────────────────────────────────────────

describe("sendText", () => {
  it("sends a single chunk to a group target", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendText({ client, to: "group:1", text: "hi there" });

    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(1);
    expect(raw.sendGroupMessage.mock.calls[0]?.[0]).toBe(1);
    expect(result.messageIds).toEqual(["1"]);
  });

  it("routes to sendPrivateMessage for a private target", async () => {
    const { client, raw } = makeFakeClient();

    await sendText({ client, to: "private:9", text: "hi" });

    expect(raw.sendPrivateMessage).toHaveBeenCalledTimes(1);
    expect(raw.sendPrivateMessage.mock.calls[0]?.[0]).toBe(9);
    expect(raw.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("chunks long text into multiple sends and returns every message id", async () => {
    const { client, raw } = makeFakeClient();
    const longText = "a".repeat(25);

    const result = await sendText({ client, to: "group:1", text: longText, chunkLimit: 10 });

    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(3);
    expect(result.messageIds).toEqual(["1", "2", "3"]);
  });

  it("attaches the reply segment only to the first chunk", async () => {
    const { client, raw } = makeFakeClient();
    const longText = "a".repeat(25);

    await sendText({ client, to: "group:1", text: longText, chunkLimit: 10, replyToId: "555" });

    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(3);
    const chainToSegments = (call: unknown[]) => {
      const message = call[1] as { toSegments?: () => Array<{ type: string }> };
      return message.toSegments ? message.toSegments() : [];
    };

    const firstSegments = chainToSegments(raw.sendGroupMessage.mock.calls[0]!);
    const secondSegments = chainToSegments(raw.sendGroupMessage.mock.calls[1]!);
    const thirdSegments = chainToSegments(raw.sendGroupMessage.mock.calls[2]!);

    expect(firstSegments.some((seg) => seg.type === "reply")).toBe(true);
    expect(secondSegments.some((seg) => seg.type === "reply")).toBe(false);
    expect(thirdSegments.some((seg) => seg.type === "reply")).toBe(false);
  });

  it("sends nothing and returns no ids for empty/whitespace text", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendText({ client, to: "group:1", text: "   " });

    expect(raw.sendGroupMessage).not.toHaveBeenCalled();
    expect(result.messageIds).toEqual([]);
  });

  it("throws (without sending) on an unparseable target", async () => {
    const { client, raw } = makeFakeClient();

    await expect(sendText({ client, to: "bogus:1:2", text: "hi" })).rejects.toThrow();
    expect(raw.sendGroupMessage).not.toHaveBeenCalled();
    expect(raw.sendPrivateMessage).not.toHaveBeenCalled();
  });
});

// ── sendText / sendMedia — debug mode ──────────────────────────────────────

describe("outbound debug mode", () => {
  it("emits one raw-payload debug line per chunk, tagged with the target and chunk index", async () => {
    const { client } = makeFakeClient();
    const lines: string[] = [];

    await sendText({ client, to: "group:1", text: "a".repeat(25), chunkLimit: 10, debug: { log: (l) => lines.push(l) } });

    expect(lines).toHaveLength(3);
    for (const line of lines) expect(line).toContain("sendGroupMessage snowluma:group:1");
    expect(lines[0]).toContain('"chunk":"1/3"');
    expect(lines[2]).toContain('"chunk":"3/3"');
  });

  it("serializes the raw OneBot segments of the outgoing message", async () => {
    const { client } = makeFakeClient();
    const lines: string[] = [];

    await sendText({ client, to: "group:1", text: "hello", debug: { log: (l) => lines.push(l) } });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"type":"text"');
    expect(lines[0]).toContain("hello");
  });

  it("records the reply segment on the first chunk only", async () => {
    const { client } = makeFakeClient();
    const lines: string[] = [];

    await sendText({
      client,
      to: "group:1",
      text: "a".repeat(25),
      chunkLimit: 10,
      replyToId: "555",
      debug: { log: (l) => lines.push(l) },
    });

    expect(lines[0]).toContain('"replyToId":"555"');
    expect(lines[0]).toContain('"type":"reply"');
    expect(lines[1]).not.toContain("replyToId");
    expect(lines[1]).not.toContain('"type":"reply"');
  });

  it("emits nothing extra and behaves normally when no debug sink is given", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendText({ client, to: "group:1", text: "hi" });

    expect(result.messageIds).toEqual(["1"]);
    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(1);
  });

  it("debug-logs the image send and the caption send separately", async () => {
    const { client } = makeFakeClient();
    const lines: string[] = [];

    await sendMedia({
      client,
      to: "group:1",
      mediaPath: "https://example.com/pic.png",
      caption: "look",
      debug: { log: (l) => lines.push(l) },
    });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("sendImage snowluma:group:1");
    expect(lines[1]).toContain("sendGroupMessage snowluma:group:1");
  });

  it("suppresses OpenClaw's canned empty-inbound notice at the chokepoint (sends nothing)", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendText({
      client,
      to: "group:1",
      text: "I didn't receive any text in your message. Please resend or add a caption.",
    });

    expect(raw.sendGroupMessage).not.toHaveBeenCalled();
    expect(result.messageIds).toEqual([]);
  });

  it("suppresses the notice even when a prefix wraps it", async () => {
    const { client, raw } = makeFakeClient();

    await sendText({ client, to: "group:1", text: "【提示】I didn't receive any text in your message. blah" });

    expect(raw.sendGroupMessage).not.toHaveBeenCalled();
  });

  it("debug-logs the raw params of the file-upload fallback", async () => {
    const { client } = makeFakeClient();
    const lines: string[] = [];

    await sendMedia({ client, to: "group:1", mediaPath: "https://example.com/doc.pdf", debug: { log: (l) => lines.push(l) } });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("upload_group_file");
    expect(lines[0]).toContain('"group_id":1');
  });
});

// ── sendMedia ────────────────────────────────────────────────────────────

describe("sendMedia", () => {
  it("routes image extensions through the image() builder to sendGroupMessage", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendMedia({ client, to: "group:1", mediaPath: "https://example.com/pic.png" });

    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(1);
    expect(raw.raw).not.toHaveBeenCalled();
    const message = raw.sendGroupMessage.mock.calls[0]?.[1] as { toSegments: () => Array<{ type: string }> };
    expect(message.toSegments()[0]?.type).toBe("image");
    expect(result.messageIds).toEqual(["1"]);
  });

  it("routes audio extensions through the record() builder", async () => {
    const { client, raw } = makeFakeClient();

    await sendMedia({ client, to: "private:2", mediaPath: "https://example.com/clip.mp3" });

    expect(raw.sendPrivateMessage).toHaveBeenCalledTimes(1);
    const message = raw.sendPrivateMessage.mock.calls[0]?.[1] as { toSegments: () => Array<{ type: string }> };
    expect(message.toSegments()[0]?.type).toBe("record");
  });

  it("falls back to a group-file upload for unrecognized extensions", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendMedia({ client, to: "group:1", mediaPath: "https://example.com/doc.pdf" });

    expect(raw.raw).toHaveBeenCalledTimes(1);
    expect(raw.raw.mock.calls[0]?.[0]).toBe("upload_group_file");
    expect(raw.raw.mock.calls[0]?.[1]).toMatchObject({ group_id: 1 });
    expect(result.messageIds).toEqual(["file-abc"]);
  });

  it("falls back to a private-file upload for unrecognized extensions on a private target", async () => {
    const { client, raw } = makeFakeClient();

    await sendMedia({ client, to: "private:2", mediaPath: "https://example.com/doc.zip" });

    expect(raw.raw).toHaveBeenCalledTimes(1);
    expect(raw.raw.mock.calls[0]?.[0]).toBe("upload_private_file");
    expect(raw.raw.mock.calls[0]?.[1]).toMatchObject({ user_id: 2 });
  });

  it("converts a bare absolute local path to a file:// URI", async () => {
    const { client, raw } = makeFakeClient();
    const absolutePath = path.resolve("some", "dir", "photo.jpg");

    await sendMedia({ client, to: "group:1", mediaPath: absolutePath });

    const message = raw.sendGroupMessage.mock.calls[0]?.[1] as { toSegments: () => Array<{ type: string; data: { file: string } }> };
    expect(message.toSegments()[0]?.data.file).toBe(pathToFileURL(absolutePath).href);
  });

  it("leaves http(s):// and file:// URIs untouched", async () => {
    const { client, raw } = makeFakeClient();

    await sendMedia({ client, to: "group:1", mediaPath: "http://example.com/a.png" });
    let message = raw.sendGroupMessage.mock.calls[0]?.[1] as { toSegments: () => Array<{ data: { file: string } }> };
    expect(message.toSegments()[0]?.data.file).toBe("http://example.com/a.png");

    await sendMedia({ client, to: "group:1", mediaPath: "file:///already/converted.png" });
    message = raw.sendGroupMessage.mock.calls[1]?.[1] as { toSegments: () => Array<{ data: { file: string } }> };
    expect(message.toSegments()[0]?.data.file).toBe("file:///already/converted.png");
  });

  it("sends the caption as a separate text message after the media, in order", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendMedia({
      client,
      to: "group:1",
      mediaPath: "https://example.com/pic.png",
      caption: "look at this",
    });

    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(2);
    const [mediaCall, captionCall] = raw.sendGroupMessage.mock.calls;
    const mediaSegments = (mediaCall?.[1] as { toSegments: () => Array<{ type: string }> }).toSegments();
    const captionSegments = (captionCall?.[1] as { toSegments: () => Array<{ type: string; data: { text: string } }> }).toSegments();
    expect(mediaSegments[0]?.type).toBe("image");
    expect(captionSegments[0]).toMatchObject({ type: "text", data: { text: "look at this" } });
    expect(result.messageIds).toEqual(["1", "2"]);
  });

  it("omits the caption message when caption is empty/whitespace", async () => {
    const { client, raw } = makeFakeClient();

    const result = await sendMedia({
      client,
      to: "group:1",
      mediaPath: "https://example.com/pic.png",
      caption: "   ",
    });

    expect(raw.sendGroupMessage).toHaveBeenCalledTimes(1);
    expect(result.messageIds).toEqual(["1"]);
  });
});

// ── reactToMessage ───────────────────────────────────────────────────────

describe("reactToMessage", () => {
  it("returns ok:true on success", async () => {
    const { client, raw } = makeFakeClient();

    const result = await reactToMessage(client, "123", "4");

    expect(result).toEqual({ ok: true });
    expect(raw.setMsgEmojiLike).toHaveBeenCalledWith(123, "4");
  });

  it("returns ok:false with the error message instead of throwing", async () => {
    const { client } = makeFakeClient({
      setMsgEmojiLike: vi.fn().mockRejectedValue(new Error("rate limited")),
    });

    const result = await reactToMessage(client, 123, 4);

    expect(result.ok).toBe(false);
    expect(result.error).toContain("rate limited");
  });
});
