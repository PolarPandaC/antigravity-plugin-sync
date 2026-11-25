import * as zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buf) >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Deterministic DOS timestamp: 2025-01-01 00:00:00
const DOS_TIME = 0;
const DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1;

/**
 * Build a deterministic ZIP buffer from `[{ name, data, mode }]` using pure Node zlib.
 */
export function createZipBuffer(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const rawData = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(rawData);
    const deflated = zlib.deflateRawSync(rawData, { level: 6 });
    const useDeflate = deflated.length < rawData.length;
    const method = useDeflate ? 8 : 0;
    const compData = useDeflate ? deflated : rawData;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4); // version needed
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra len

    localParts.push(localHeader, nameBuf, compData);

    const unixMode = (0o100000 | ((entry.mode ?? 0o644) & 0o777)) >>> 0;
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE((3 << 8) | 20, 4); // Unix + PKZIP 2.0
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra len
    centralHeader.writeUInt16LE(0, 32); // comment len
    centralHeader.writeUInt16LE(0, 34); // disk start
    centralHeader.writeUInt16LE(0, 36); // internal attrs
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset >>> 0, 42);

    centralParts.push(centralHeader, nameBuf);
    offset += localHeader.length + nameBuf.length + compData.length;
  }

  const centralSize = centralParts.reduce((acc, b) => acc + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize >>> 0, 12);
  eocd.writeUInt32LE(offset >>> 0, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

/**
 * Parse a ZIP buffer and return `[{ name, data, isDir, unixMode }]`.
 */
export function readZipBuffer(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const minOffset = Math.max(0, buf.length - 65557);
  let eocdPos = -1;
  for (let i = buf.length - 22; i >= minOffset; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(i + 20);
      if (i + 22 + commentLen === buf.length) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos < 0) {
    throw new Error('Invalid ZIP archive: EOCD not found');
  }

  const totalEntries = buf.readUInt16LE(eocdPos + 10);
  const centralOffset = buf.readUInt32LE(eocdPos + 16);
  let ptr = centralOffset;
  const results = [];

  for (let idx = 0; idx < totalEntries; idx++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error('Invalid ZIP central directory header');
    }
    const method = buf.readUInt16LE(ptr + 10);
    const expectedCrc = buf.readUInt32LE(ptr + 16);
    const compSize = buf.readUInt32LE(ptr + 20);
    const uncompSize = buf.readUInt32LE(ptr + 24);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const extAttrs = buf.readUInt32LE(ptr + 38);
    const localOffset = buf.readUInt32LE(ptr + 42);

    const name = buf.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8');
    ptr += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}`);
    }
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const dataEnd = dataStart + compSize;
    if (dataEnd > buf.length) {
      throw new Error(`Truncated ZIP entry: ${name}`);
    }

    const compSlice = buf.subarray(dataStart, dataEnd);
    const isDir = name.endsWith('/');
    let data;
    if (isDir) {
      data = Buffer.alloc(0);
    } else if (method === 0) {
      data = Buffer.from(compSlice);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compSlice);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (!isDir) {
      if (data.length !== uncompSize) {
        throw new Error(`ZIP size mismatch for ${name}`);
      }
      if (crc32(data) !== expectedCrc) {
        throw new Error(`ZIP CRC32 mismatch for ${name}`);
      }
    }

    const unixMode = (extAttrs >>> 16) & 0o777;
    results.push({ name, data, isDir, unixMode });
  }

  return results;
}
