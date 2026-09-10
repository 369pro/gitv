import type {
  ObjectType,
  ParsedBody,
  Field,
  TreeEntry,
  DeltaInstruction,
  IndexEntry,
  IndexData,
} from "./types.js";
import { createHash } from "node:crypto";

export const LIMIT = 64 * 1024 * 1024;
export const hash = (data: Buffer, algorithm = "sha1") =>
  createHash(algorithm).update(data).digest("hex");
export const oidFor = (type: string, body: Buffer, algorithm = "sha1") =>
  hash(
    Buffer.concat([Buffer.from(`${type} ${body.length}\0`), body]),
    algorithm,
  );
export function page(buffer: Buffer, offset = 0, length = 512) {
  offset = Math.max(0, Number(offset) || 0);
  const part = buffer.subarray(
    offset,
    offset + Math.min(65536, Math.max(1, length)),
  );
  return {
    offset,
    total: buffer.length,
    hex: part.toString("hex"),
    text: part.toString("utf8"),
    next: offset + part.length < buffer.length ? offset + part.length : null,
  };
}
export function content(buffer: Buffer, offset = 0, length = 8192) {
  const sample = buffer.subarray(0, 8192);
  const binary =
    sample.includes(0) || sample.toString("utf8").split("\ufffd").length > 4;
  let mime = null;
  if (buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a")
    mime = "image/png";
  if (buffer[0] === 255 && buffer[1] === 216) mime = "image/jpeg";
  if (buffer.subarray(0, 3).toString() === "GIF") mime = "image/gif";
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    mime = "image/webp";
  const histogram = Array<number>(32).fill(0);
  for (const b of buffer.subarray(0, 65536)) histogram[b >> 3]++;
  return {
    ...page(buffer, offset, length),
    binary,
    histogram,
    image:
      mime && buffer.length < 2 * 1024 * 1024
        ? `data:${mime};base64,${buffer.toString("base64")}`
        : null,
  };
}
export function parseBody(
  type: ObjectType,
  body: Buffer,
  hashBytes = 20,
): ParsedBody {
  const fields: Field[] = [];
  if (type === "tree") {
    const entries = [];
    let at = 0;
    while (at < body.length) {
      const start = at,
        space = body.indexOf(32, at),
        nul = body.indexOf(0, space);
      if (space < at || nul < space || nul + 1 + hashBytes > body.length)
        throw Error("Truncated tree entry");
      const mode = body.toString("ascii", at, space),
        name = body.toString("utf8", space + 1, nul);
      const oid = body.subarray(nul + 1, nul + 1 + hashBytes).toString("hex");
      at = nul + 1 + hashBytes;
      const entry: TreeEntry = {
        mode,
        name,
        oid,
        type:
          mode === "40000" ? "tree" : mode === "160000" ? "gitlink" : "blob",
        start,
        end: at,
      };
      entries.push(entry);
      fields.push(
        { name: "mode", value: mode, start, end: space },
        { name: "name", value: name, start: space + 1, end: nul },
        { name: "oid", value: oid, start: nul + 1, end: at },
      );
    }
    return { entries, fields };
  }
  if (type === "commit" || type === "tag") {
    let at = 0;
    const headers: Record<string, string[]> = {};
    while (at < body.length && body[at] !== 10) {
      let end = body.indexOf(10, at);
      if (end < 0) end = body.length;
      const space = body.indexOf(32, at);
      if (space < at || space > end) throw Error("Malformed object header");
      const name = body.toString("utf8", at, space),
        value = body.toString("utf8", space + 1, end);
      (headers[name] ||= []).push(value);
      fields.push({ name, value, start: at, end });
      at = end + 1;
    }
    const message = body.toString("utf8", at + 1);
    fields.push({
      name: "message",
      value: message,
      start: at + 1,
      end: body.length,
    });
    return {
      headers,
      message,
      fields,
      tree: headers.tree?.[0],
      parents: headers.parent || [],
      object: headers.object?.[0],
      subject: message.split("\n")[0],
    };
  }
  return {
    fields: [
      {
        name: "body",
        value: `${body.length} bytes`,
        start: 0,
        end: body.length,
      },
    ],
  };
}

export function applyDelta(base: Buffer, delta: Buffer) {
  let at = 0;
  const byte = () => {
    if (at >= delta.length) throw Error("Truncated delta");
    return delta[at++];
  };
  const size = () => {
    let n = 0,
      shift = 0,
      b;
    do {
      b = byte();
      n += (b & 127) * 2 ** shift;
      shift += 7;
      if (shift > 53) throw Error("Delta size overflow");
    } while (b & 128);
    return n;
  };
  const baseSize = size(),
    resultSize = size();
  if (baseSize !== base.length || resultSize > LIMIT)
    throw Error("Invalid or oversized delta");
  const result = Buffer.alloc(resultSize),
    instructions: DeltaInstruction[] = [];
  let out = 0;
  while (at < delta.length) {
    const start = at,
      op = byte();
    let offset = 0,
      length = 0;
    if (op & 128) {
      for (let i = 0; i < 4; i++)
        if (op & (1 << i)) offset += byte() * 2 ** (8 * i);
      for (let i = 0; i < 3; i++)
        if (op & (16 << i)) length += byte() * 2 ** (8 * i);
      length ||= 65536;
      if (offset + length > base.length || out + length > result.length)
        throw Error("Delta copy out of bounds");
      base.copy(result, out, offset, offset + length);
      instructions.push({
        op: "copy",
        offset,
        length,
        start,
        end: at,
        output: out,
      });
    } else {
      length = op;
      if (!op || at + length > delta.length || out + length > result.length)
        throw Error("Invalid delta insert");
      delta.copy(result, out, at, at + length);
      at += length;
      instructions.push({ op: "insert", length, start, end: at, output: out });
    }
    out += length;
  }
  if (out !== resultSize) throw Error("Delta result length mismatch");
  return { body: result, instructions, baseSize, resultSize };
}

export function parseIndex(raw: Buffer, algorithm = "sha1"): IndexData {
  const h = algorithm === "sha256" ? 32 : 20;
  if (raw.length < 12 + h || raw.toString("ascii", 0, 4) !== "DIRC")
    throw Error("Invalid index signature");
  const version = raw.readUInt32BE(4),
    count = raw.readUInt32BE(8);
  if (![2, 3, 4].includes(version))
    throw Error(`Unsupported index v${version}`);
  if (hash(raw.subarray(0, -h), algorithm) !== raw.subarray(-h).toString("hex"))
    throw Error("Index checksum mismatch; retry after writer completes");
  const entries: IndexEntry[] = [],
    fields: Field[] = [
      { name: "signature", start: 0, end: 4, value: "DIRC" },
      { name: "version", start: 4, end: 8, value: version },
      { name: "entries", start: 8, end: 12, value: count },
    ];
  let at = 12,
    previous: Buffer = Buffer.alloc(0);
  for (let i = 0; i < count; i++) {
    const start = at;
    if (at + 42 + h > raw.length - h) throw Error("Truncated index");
    const mode = raw.readUInt32BE(at + 24).toString(8),
      size = raw.readUInt32BE(at + 36);
    const oid = raw.subarray(at + 40, at + 40 + h).toString("hex"),
      flags = raw.readUInt16BE(at + 40 + h);
    at += 42 + h;
    let extended = 0;
    if (flags & 0x4000) {
      extended = raw.readUInt16BE(at);
      at += 2;
    }
    let strip = 0;
    if (version === 4) {
      let b = raw[at++];
      strip = b & 127;
      while (b & 128) {
        b = raw[at++];
        strip = (strip + 1) * 128 + (b & 127);
        if (at >= raw.length) throw Error("Invalid index prefix");
      }
    }
    const nameStart = at,
      end = raw.indexOf(0, at);
    if (end < at || end >= raw.length - h || strip > previous.length)
      throw Error("Invalid index path");
    const name =
      version === 4
        ? Buffer.concat([
            previous.subarray(0, previous.length - strip),
            raw.subarray(at, end),
          ])
        : raw.subarray(at, end);
    at = version === 4 ? end + 1 : start + Math.ceil((end + 1 - start) / 8) * 8;
    const entry = {
      path: name.toString("utf8"),
      oid,
      mode,
      size,
      stage: (flags >> 12) & 3,
      flags,
      extended,
      start,
      end: at,
    };
    entries.push(entry);
    previous = name;
    fields.push(
      { name: "mode", start: start + 24, end: start + 28, value: mode },
      { name: "oid", start: start + 40, end: start + 40 + h, value: oid },
      {
        name: "flags / stage",
        start: start + 40 + h,
        end: start + 42 + h,
        value: `${flags.toString(16)} / ${entry.stage}`,
      },
      { name: "path", start: nameStart, end, value: entry.path },
    );
  }
  const extensions = [];
  while (at < raw.length - h) {
    if (at + 8 > raw.length - h) throw Error("Truncated index extension");
    const name = raw.toString("ascii", at, at + 4),
      size = raw.readUInt32BE(at + 4);
    if (at + 8 + size > raw.length - h)
      throw Error("Invalid index extension length");
    extensions.push({ name, size, start: at, end: at + 8 + size });
    fields.push({
      name,
      start: at,
      end: at + 8 + size,
      value: `${size} bytes`,
    });
    at += 8 + size;
  }
  return {
    version,
    count,
    entries,
    extensions,
    fields,
    checksum: true,
    partial: extensions.some((e) => /^[a-z]/.test(e.name)),
  };
}

export function parseMetadata(raw: Buffer, name: string) {
  const fields: Field[] = [],
    links: string[] = [];
  let at = 0;
  for (const line of raw.toString("utf8").split("\n")) {
    const length = Buffer.byteLength(line),
      end = at + length;
    if (line.startsWith("ref: ")) {
      fields.push(
        { name: "symbolic marker", value: "ref:", start: at, end: at + 4 },
        { name: "ref target", value: line.slice(5), start: at + 5, end },
      );
    } else if (name.startsWith("logs/")) {
      const m = /^(\S+) (\S+) (.*)\t(.*)$/.exec(line);
      if (m) {
        const tab = raw.indexOf(9, at),
          h = m[1].length;
        fields.push(
          { name: "old oid", value: m[1], start: at, end: at + h },
          {
            name: "new oid",
            value: m[2],
            start: at + h + 1,
            end: at + h + 1 + m[2].length,
          },
          {
            name: "actor / time / zone",
            value: m[3],
            start: at + 2 * h + 2,
            end: tab,
          },
          { name: "action", value: m[4], start: tab + 1, end },
        );
        links.push(m[1], m[2]);
      }
    } else if (/^[a-f0-9]{40,64}( |$)/.test(line)) {
      const [oid, ...rest] = line.split(" ");
      fields.push({ name: "oid", value: oid, start: at, end: at + oid.length });
      links.push(oid);
      if (rest.length)
        fields.push({
          name: name === "packed-refs" ? "ref name" : "value",
          value: rest.join(" "),
          start: at + oid.length + 1,
          end,
        });
    } else if (line.startsWith("^")) {
      fields.push({
        name: "peeled target",
        value: line.slice(1),
        start: at + 1,
        end,
      });
      links.push(line.slice(1));
    } else if (line)
      fields.push({
        name: line.startsWith("#")
          ? "comment"
          : name.includes("todo") || name.endsWith("done")
            ? "instruction"
            : "value",
        value: line,
        start: at,
        end,
      });
    at = end + 1;
  }
  return {
    text: raw.toString("utf8"),
    fields,
    links: [...new Set(links)].filter((s) => !/^0+$/.test(s)),
  };
}
