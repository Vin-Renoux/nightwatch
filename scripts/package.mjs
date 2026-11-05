#!/usr/bin/env node
/**
 * Builds the installable extension: dist/nightwatch-<version>.zip, holding only
 * what the browser needs — no tests, fixtures, screenshots or dev harness.
 *
 *   npm run package
 *
 * Dependency-free: Node's zlib provides the deflate and CRC-32 a zip needs.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateRawSync } from "node:zlib";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const INCLUDE = ["manifest.json", "background", "content", "lib", "popup", "rules", "icons"];
// Development-only files inside those folders.
const EXCLUDE = new Set(["popup/preview.html"]);

const manifest = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const files = INCLUDE.flatMap((entry) => walk(join(ROOT, entry)))
  .map((path) => relative(ROOT, path).split(sep).join("/"))
  .filter((path) => !EXCLUDE.has(path))
  .sort();

const zip = buildZip(files.map((path) => ({ path, data: readFileSync(join(ROOT, path)) })));
const outDir = join(ROOT, "dist");
const outFile = join(outDir, `nightwatch-${manifest.version}.zip`);
mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, zip);

console.log(`${relative(ROOT, outFile)}  (${files.length} files, ${(zip.length / 1024).toFixed(1)} KB)`);
for (const path of files) console.log(`  ${path}`);


function walk(path) {
  if (statSync(path).isFile()) return [path];
  return readdirSync(path).flatMap((name) => walk(join(path, name)));
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const [time, date] = dosDateTime(new Date());

  for (const { path, data } of entries) {
    const name = Buffer.from(path, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

function dosDateTime(when) {
  const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
  const date = ((when.getFullYear() - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
  return [time, date];
}
