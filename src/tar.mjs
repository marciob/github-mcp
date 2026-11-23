// Reads the files of a .tar.gz in memory, with no dependency. GitHub sends
// a repository as a tarball with pax headers, and each path starts with one
// top directory ("owner-repo-sha/"), which this reader removes.
//
// Source: https://www.gnu.org/software/tar/manual/html_node/Standard.html
import zlib from "node:zlib";

const cstr = (buf, start, len) => {
  const end = buf.indexOf(0, start);
  return buf.toString("utf8", start, end === -1 || end > start + len ? start + len : end);
};
const octal = (buf, start, len) => parseInt(cstr(buf, start, len).trim() || "0", 8);

function paxPath(body) {
  // Records: "<len> key=value\n".
  let i = 0;
  let out = null;
  while (i < body.length) {
    const sp = body.indexOf(0x20, i);
    if (sp === -1) break;
    const len = parseInt(body.toString("utf8", i, sp), 10);
    if (!len) break;
    const rec = body.toString("utf8", sp + 1, i + len - 1);
    const eq = rec.indexOf("=");
    if (rec.slice(0, eq) === "path") out = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

// Calls `onFile(path, data)` for each regular file. Stops when it returns false.
export function readTarGz(gz, onFile, { maxBytes = 200 * 1024 * 1024 } = {}) {
  const buf = zlib.gunzipSync(gz, { maxOutputLength: maxBytes });
  let off = 0;
  let nextPath = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 0x30);
    const prefix = cstr(h, 345, 155);
    let name = cstr(h, 0, 100);
    if (prefix) name = `${prefix}/${name}`;
    const start = off + 512;
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    if (type === "x") {
      nextPath = paxPath(data);
      continue;
    }
    if (type === "g") continue;
    if (type === "L") {
      nextPath = data.toString("utf8").replace(/\0+$/, "");
      continue;
    }
    const full = nextPath ?? name;
    nextPath = null;
    if (type !== "0" && type !== "\0") continue;
    const rel = full.includes("/") ? full.slice(full.indexOf("/") + 1) : full;
    if (rel && onFile(rel, data) === false) break;
  }
}
