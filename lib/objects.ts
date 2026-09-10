import type {
  ObjectType,
  Storage,
  ParsedBody,
  DeltaInstruction,
  BytePage,
} from "./types.js";
import { errorCode } from "./errors.js";
import { readFile, readdir, stat, open } from "node:fs/promises";
import path from "node:path";
import { inflateSync } from "node:zlib";
import {
  hash,
  oidFor,
  parseBody,
  applyDelta,
  LIMIT,
  page,
  content,
} from "./bytes.js";

interface PackEntry {
  oid: string;
  offset: number;
  end: number;
  oidStart: number;
  offsetStart: number;
}
interface Pack {
  filename: string;
  packfile: string;
  raw: Buffer;
  count: number;
  version: number;
  objects: Map<string, PackEntry>;
  byOffset: Map<number, PackEntry>;
}
interface StoredBytes {
  oid: string;
  type: ObjectType;
  body: Buffer;
  raw: Buffer;
  source: string;
  storage: Storage;
  offset: number;
  header: string;
  compressedOffset: number;
  cost?: number;
  retained?: boolean;
  delta?: Buffer | null;
  baseOid?: string | null;
  baseOffset?: number | null;
  instructions?: DeltaInstruction[];
  packHeader?: string;
  indexSource?: string;
  indexVersion?: number;
  indexCount?: number;
  indexEvidence?: (BytePage & { label: string })[];
  typeCode?: number;
  encodedSize?: number;
}
export interface StoredObject extends StoredBytes {
  parsed: ParsedBody;
}
export class ObjectStore {
  directory: string;
  algorithm: string;
  hashBytes: number;
  cache: Map<string, StoredObject>;
  cacheBytes: number;
  packs: Pack[];
  packSignature: string;
  constructor(directory: string, algorithm = "sha1") {
    this.directory = directory;
    this.algorithm = algorithm;
    this.hashBytes = algorithm === "sha256" ? 32 : 20;
    this.cache = new Map();
    this.cacheBytes = 0;
    this.packs = [];
    this.packSignature = "";
  }
  async refresh() {
    const dir = path.join(this.directory, "pack");
    const names = (await readdir(dir).catch(() => []))
      .filter((n) => n.endsWith(".idx"))
      .sort();
    const signature = (
      await Promise.all(
        names.map(async (n) => {
          const s = await stat(path.join(dir, n));
          return `${n}:${s.size}:${s.mtimeMs}`;
        }),
      )
    ).join("|");
    if (signature === this.packSignature) return;
    const packs = [];
    for (const name of names) {
      const filename = path.join(dir, name),
        size = (await stat(filename)).size;
      if (size > LIMIT)
        throw Error("Pack index exceeds 64 MiB inspection limit");
      const raw = await readFile(filename),
        h = this.hashBytes;
      const v2 = raw.readUInt32BE(0) === 0xff744f63;
      if (v2 && raw.readUInt32BE(4) !== 2)
        throw Error("Unsupported pack index version");
      if (
        hash(raw.subarray(0, -h), this.algorithm) !==
        raw.subarray(-h).toString("hex")
      )
        throw Error("Pack index checksum mismatch");
      const fan = v2 ? 8 : 0,
        count = raw.readUInt32BE(fan + 1020),
        table = fan + 1024;
      const objects = new Map<string, PackEntry>(),
        offsets = [];
      for (let i = 0; i < count; i++) {
        const oidStart = v2 ? table + i * h : table + i * (h + 4) + 4;
        const oid = raw.subarray(oidStart, oidStart + h).toString("hex");
        const offsetStart = v2
          ? table + count * (h + 4) + i * 4
          : table + i * (h + 4);
        let offset = raw.readUInt32BE(offsetStart);
        if (v2 && offset >= 0x80000000)
          offset = Number(
            raw.readBigUInt64BE(
              table + count * (h + 8) + (offset - 0x80000000) * 8,
            ),
          );
        const entry: PackEntry = { oid, offset, oidStart, offsetStart, end: 0 };
        objects.set(oid, entry);
        offsets.push(entry);
      }
      offsets.sort((a, b) => a.offset - b.offset);
      const packfile = filename.slice(0, -4) + ".pack",
        packSize = (await stat(packfile)).size;
      for (let i = 0; i < offsets.length; i++)
        offsets[i].end = offsets[i + 1]?.offset ?? packSize - h;
      packs.push({
        filename,
        packfile,
        raw,
        count,
        version: v2 ? 2 : 1,
        objects,
        byOffset: new Map(offsets.map((e) => [e.offset, e])),
      });
    }
    this.packs = packs;
    this.packSignature = signature;
  }
  remember(oid: string, object: StoredObject) {
    const cost =
      object.body.length + object.raw.length + (object.delta?.length || 0);
    if (cost < LIMIT) {
      while (this.cacheBytes + cost > LIMIT && this.cache.size) {
        const key = this.cache.keys().next().value!;
        this.cacheBytes -= this.cache.get(key)!.cost || 0;
        this.cache.delete(key);
      }
      object.cost = cost;
      this.cache.set(oid, object);
      this.cacheBytes += cost;
    }
    return object;
  }
  async read(oid: string, stack = new Set<string>()): Promise<StoredObject> {
    if (!new RegExp(`^[0-9a-f]{${this.hashBytes * 2}}$`).test(oid))
      throw Error("Expected a complete object ID");
    let retained;
    if (this.cache.has(oid)) {
      const cached = this.cache.get(oid)!;
      if (await stat(cached.source).catch(() => null)) return cached;
      retained = cached;
      this.cache.delete(oid);
      this.cacheBytes -= cached.cost || 0;
    }
    if (stack.size > 100 || stack.has(oid))
      throw Error("Cyclic or excessively deep delta chain");
    stack = new Set(stack).add(oid);
    const filename = path.join(this.directory, oid.slice(0, 2), oid.slice(2));
    let object: StoredBytes;
    try {
      if ((await stat(filename)).size > LIMIT)
        throw Error("Object exceeds 64 MiB inspection limit");
      const raw = await readFile(filename),
        inflated = inflateSync(raw, { maxOutputLength: LIMIT });
      const nul = inflated.indexOf(0),
        header = inflated.toString("ascii", 0, nul);
      const match = /^(blob|tree|commit|tag) (\d+)$/.exec(header);
      if (nul < 0 || !match || Number(match[2]) !== inflated.length - nul - 1)
        throw Error("Invalid loose object header");
      object = {
        oid,
        type: match[1] as ObjectType,
        body: inflated.subarray(nul + 1),
        raw,
        storage: "loose",
        source: filename,
        offset: 0,
        header,
        compressedOffset: 0,
      };
    } catch (e) {
      if (errorCode(e) !== "ENOENT") throw e;
      await this.refresh();
      const pack = this.packs.find((p) => p.objects.has(oid));
      if (!pack) {
        if (retained)
          return this.remember(oid, { ...retained, retained: true });
        throw Error(
          `Object ${oid.slice(0, 10)} is missing, unsupported, or no longer retained`,
        );
      }
      object = await this.readPacked(pack, pack.objects.get(oid)!, stack);
    }
    if (oidFor(object.type, object.body, this.algorithm) !== oid)
      throw Error("Object hash mismatch");
    return this.remember(oid, {
      ...object,
      parsed: parseBody(object.type, object.body, this.hashBytes),
    });
  }
  async readPacked(
    pack: Pack,
    entry: PackEntry,
    stack: Set<string>,
  ): Promise<StoredBytes> {
    const length = entry.end - entry.offset;
    if (length <= 0 || length > LIMIT)
      throw Error("Packed entry exceeds inspection limit");
    const handle = await open(pack.packfile, "r");
    let raw, packHeader;
    try {
      raw = Buffer.alloc(length);
      packHeader = Buffer.alloc(12);
      const read = await handle.read(raw, 0, length, entry.offset);
      await handle.read(packHeader, 0, 12, 0);
      if (
        read.bytesRead !== length ||
        packHeader.toString("ascii", 0, 4) !== "PACK" ||
        ![2, 3].includes(packHeader.readUInt32BE(4))
      )
        throw Error("Invalid or truncated pack");
    } finally {
      await handle.close();
    }
    let at = 0,
      b = raw[at++],
      typeCode = (b >> 4) & 7,
      size = b & 15,
      shift = 4;
    while (b & 128) {
      b = raw[at++];
      size += (b & 127) * 2 ** shift;
      shift += 7;
      if (shift > 53 || at >= raw.length) throw Error("Invalid pack size");
    }
    let baseOid: string | null | undefined = null,
      baseOffset: number | null = null;
    if (typeCode === 6) {
      b = raw[at++];
      let distance = b & 127;
      while (b & 128) {
        b = raw[at++];
        distance = (distance + 1) * 128 + (b & 127);
        if (at >= raw.length) throw Error("Invalid delta offset");
      }
      baseOffset = entry.offset - distance;
      baseOid = pack.byOffset.get(baseOffset)?.oid;
      if (!baseOid) throw Error("Missing OFS_DELTA base");
    } else if (typeCode === 7) {
      baseOid = raw.subarray(at, at + this.hashBytes).toString("hex");
      at += this.hashBytes;
    }
    const inflated = inflateSync(raw.subarray(at), { maxOutputLength: LIMIT });
    if (inflated.length !== size) throw Error("Packed object size mismatch");
    let body: Buffer = inflated,
      deltaInfo,
      type = ([undefined, "commit", "tree", "blob", "tag"] as const)[typeCode];
    if (baseOid) {
      const base = await this.read(baseOid, stack);
      type = base.type;
      deltaInfo = applyDelta(base.body, inflated);
      body = deltaInfo.body;
    }
    if (!type) throw Error(`Unsupported pack type ${typeCode}`);
    return {
      oid: entry.oid,
      type,
      body,
      raw,
      source: pack.packfile,
      offset: entry.offset,
      storage: baseOid ? (typeCode === 6 ? "OFS_DELTA" : "REF_DELTA") : "pack",
      compressedOffset: at,
      typeCode,
      encodedSize: size,
      baseOid,
      baseOffset,
      delta: baseOid ? inflated : null,
      instructions: deltaInfo?.instructions,
      packHeader: packHeader.toString("hex"),
      indexSource: pack.filename,
      indexVersion: pack.version,
      indexCount: pack.count,
      indexEvidence: [
        { ...page(pack.raw, 0, 16), label: "header / fanout" },
        {
          ...page(
            pack.raw,
            (pack.version === 2 ? 8 : 0) +
              parseInt(entry.oid.slice(0, 2), 16) * 4,
            4,
          ),
          label: `fanout[0x${entry.oid.slice(0, 2)}]`,
        },
        { ...page(pack.raw, entry.oidStart, this.hashBytes), label: "oid" },
        {
          ...page(pack.raw, entry.offsetStart, 4),
          label: `offset → ${entry.offset}`,
        },
      ],
      header: `${type} ${body.length}`,
    };
  }
  async inspect(oid: string, { offset = 0, part = "body" } = {}) {
    const o = await this.read(oid),
      canonical = Buffer.concat([Buffer.from(`${o.header}\0`), o.body]);
    const bytes =
      part === "raw"
        ? o.raw
        : part === "canonical"
          ? canonical
          : part === "delta"
            ? o.delta || o.body
            : o.body;
    return {
      oid,
      type: o.type,
      size: o.body.length,
      source: o.source,
      storage: o.storage,
      offset: o.offset,
      compressedOffset: o.compressedOffset,
      raw: page(o.raw),
      canonical: page(canonical),
      bytes: page(bytes, offset),
      part,
      header: o.header,
      computed: oidFor(o.type, o.body, this.algorithm),
      algorithm: this.algorithm,
      retained: !!o.retained,
      parsed: {
        ...o.parsed,
        fields: o.parsed.fields
          .filter((f) => f.end > offset && f.start < offset + 512)
          .slice(0, 500),
        entries: o.parsed.entries?.slice(0, 500),
      },
      fieldCount: o.parsed.fields.length,
      content: o.type === "blob" ? content(o.body, offset) : null,
      baseOid: o.baseOid,
      baseOffset: o.baseOffset,
      delta: o.delta ? page(o.delta) : null,
      instructions: o.instructions?.slice(0, 500),
      typeCode: o.typeCode,
      encodedSize: o.encodedSize,
      packHeader: o.packHeader,
      indexSource: o.indexSource,
      indexVersion: o.indexVersion,
      indexCount: o.indexCount,
      indexEvidence: o.indexEvidence,
    };
  }
}
