import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ValidationError } from "./errors.js";

// --- Image/file attachments ------------------------------------------------
//
// Parses OpenAI chat.completions content parts (`image_url`, `file`) into a
// normalized in-memory form both providers can consume. Everything is read
// and validated up front, at request-parse time, so a bad path/base64/type is
// a clean 400 before any CLI process is touched.
//
// What each kind becomes downstream (verified live against claude 2.1.280 /
// codex-cli 0.149.1):
//   - image: claude gets a base64 `image` content block over stream-json;
//     codex gets a temp file passed via `--image` (exec) or a `localImage`
//     input item (app-server). Both CLIs accept png/jpeg/gif/webp.
//   - pdf: claude only, as a base64 `document` content block. codex has no
//     document input at all (neither `exec` flags nor app-server's UserInput
//     union has one), so a PDF routed to codex is rejected — see
//     CliProvider.supportedAttachmentKinds.
//   - anything else that decodes as UTF-8 text is never an Attachment: it's
//     inlined straight into the transcript (see transcript.ts), which works
//     identically for both CLIs with no provider-specific handling.
//
// Local file paths are only honored under WrapperSettings.localFileRoots
// (empty by default = disabled). Without that allowlist, anyone holding the
// /v1 API key could make the server read any file its user can (~/.ssh, the
// config.json holding that very key, ...) and have the model echo it back.

export type AttachmentKind = "image" | "pdf";

export interface Attachment {
  kind: AttachmentKind;
  mediaType: string;
  filename: string;
  data: Buffer;
}

/** A text file resolved from a `file` part — inlined into the transcript rather than attached. */
export interface InlineTextFile {
  kind: "text";
  filename: string;
  text: string;
}

export type ResolvedPart = Attachment | InlineTextFile;

/** Per attachment, decoded. Both CLIs' own per-image limits are lower than this; they surface as CLI errors. */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Magic-byte sniffing — the CLIs reject a media_type that doesn't match the bytes, so never trust a declared mime alone. */
function sniffMediaType(buf: Buffer): string | undefined {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 6 && (buf.subarray(0, 6).toString("latin1") === "GIF87a" || buf.subarray(0, 6).toString("latin1") === "GIF89a")) return "image/gif";
  if (buf.length >= 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf.length >= 5 && buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  return undefined;
}

function decodeUtf8Text(buf: Buffer): string | undefined {
  if (buf.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return undefined;
  }
}

function checkSize(buf: Buffer, label: string): Buffer {
  if (buf.length === 0) throw new ValidationError(`${label} is empty`);
  if (buf.length > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError(`${label} is ${buf.length} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes per attachment`);
  }
  return buf;
}

function decodeDataUrl(url: string, label: string): Buffer {
  const comma = url.indexOf(",");
  if (comma === -1) throw new ValidationError(`${label}: malformed data: URL`);
  const meta = url.slice("data:".length, comma);
  const payload = url.slice(comma + 1);
  const buf = meta.split(";").includes("base64") ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8");
  return checkSize(buf, label);
}

function isUnderRoot(realFile: string, realRoot: string): boolean {
  const rel = path.relative(realRoot, realFile);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Reads a local file, but only if it resolves (symlinks followed) under one of `roots`. */
function readLocalFile(rawPath: string, roots: string[], label: string): { data: Buffer; filename: string } {
  if (roots.length === 0) {
    throw new ValidationError(
      `${label}: local file paths are disabled — add an allowed directory to "localFileRoots" on the settings page, or send the content as base64 instead`
    );
  }
  if (!path.isAbsolute(rawPath)) throw new ValidationError(`${label}: local file paths must be absolute`);
  let real: string;
  try {
    real = fs.realpathSync(rawPath);
  } catch {
    throw new ValidationError(`${label}: file not found: ${rawPath}`);
  }
  const allowed = roots.some((root) => {
    try {
      return isUnderRoot(real, fs.realpathSync(root));
    } catch {
      return false; // a configured root that doesn't exist allows nothing
    }
  });
  if (!allowed) throw new ValidationError(`${label}: ${rawPath} is outside every directory in "localFileRoots"`);
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new ValidationError(`${label}: ${rawPath} is not a regular file`);
  if (stat.size > MAX_ATTACHMENT_BYTES) {
    throw new ValidationError(`${label} is ${stat.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes per attachment`);
  }
  return { data: checkSize(fs.readFileSync(real), label), filename: path.basename(real) };
}

function localPathFromFileUrl(url: string, label: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname);
  } catch {
    throw new ValidationError(`${label}: malformed file:// URL`);
  }
}

/** `image_url.url`: a data: URL, a file:// URL, or a bare absolute path. Remote http(s) URLs aren't fetched. */
export function resolveImageUrl(url: unknown, index: number, roots: string[]): Attachment {
  const label = `Attachment ${index} (image_url)`;
  if (typeof url !== "string" || url.trim() === "") throw new ValidationError(`${label}: \`image_url.url\` must be a non-empty string`);
  let data: Buffer;
  let filename: string | undefined;
  if (url.startsWith("data:")) {
    data = decodeDataUrl(url, label);
  } else if (/^https?:\/\//i.test(url)) {
    throw new ValidationError(`${label}: remote image URLs aren't supported — send a base64 data: URL or a local file path instead`);
  } else {
    const p = url.startsWith("file://") ? localPathFromFileUrl(url, label) : url;
    ({ data, filename } = readLocalFile(p, roots, label));
  }
  const mediaType = sniffMediaType(data);
  if (!mediaType || !IMAGE_EXT[mediaType]) throw new ValidationError(`${label}: not a PNG, JPEG, GIF or WebP image`);
  return { kind: "image", mediaType, filename: filename ?? `image-${index}.${IMAGE_EXT[mediaType]}`, data };
}

/**
 * `file` part: `file_data` is a data: URL, raw base64 (OpenAI's own shape
 * allows either), or a file:// URL. A bare absolute path is deliberately not
 * accepted here — raw base64 can legitimately start with "/" (every JPEG's
 * does: "/9j/"), so it would be ambiguous. `file_id` refers to OpenAI's own
 * Files API, which has no equivalent here.
 */
export function resolveFilePart(file: unknown, index: number, roots: string[]): ResolvedPart {
  const label = `Attachment ${index} (file)`;
  const f = (file ?? {}) as { file_data?: unknown; filename?: unknown; file_id?: unknown };
  if (f.file_id !== undefined && f.file_data === undefined) {
    throw new ValidationError(`${label}: \`file_id\` isn't supported (there's no Files API here) — send the content in \`file_data\` instead`);
  }
  if (typeof f.file_data !== "string" || f.file_data.trim() === "") {
    throw new ValidationError(`${label}: \`file.file_data\` must be a non-empty string`);
  }
  let data: Buffer;
  let filename = typeof f.filename === "string" && f.filename.trim() !== "" ? path.basename(f.filename.trim()) : undefined;
  if (f.file_data.startsWith("data:")) {
    data = decodeDataUrl(f.file_data, label);
  } else if (f.file_data.startsWith("file://")) {
    const read = readLocalFile(localPathFromFileUrl(f.file_data, label), roots, label);
    data = read.data;
    filename ??= read.filename;
  } else {
    data = checkSize(Buffer.from(f.file_data, "base64"), label);
  }

  const sniffed = sniffMediaType(data);
  if (sniffed === "application/pdf") return { kind: "pdf", mediaType: sniffed, filename: filename ?? `document-${index}.pdf`, data };
  if (sniffed && IMAGE_EXT[sniffed]) return { kind: "image", mediaType: sniffed, filename: filename ?? `image-${index}.${IMAGE_EXT[sniffed]}`, data };
  const text = decodeUtf8Text(data);
  if (text !== undefined) return { kind: "text", filename: filename ?? `file-${index}.txt`, text };
  throw new ValidationError(`${label}: unsupported file type — only images (PNG/JPEG/GIF/WebP), PDFs and UTF-8 text files are supported`);
}

/**
 * Writes image attachments to a private temp dir for codex, which only takes
 * images by path (`--image` / `localImage`). Returns paths aligned with
 * `images`' order; call cleanup() once the CLI no longer needs them.
 */
export async function writeImagesToTempDir(images: Attachment[]): Promise<{ paths: string[]; cleanup: () => Promise<void> }> {
  if (images.length === 0) return { paths: [], cleanup: async () => {} };
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "cli-wrapper-att-"));
  const cleanup = () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  try {
    const paths: string[] = [];
    for (const [i, img] of images.entries()) {
      // Our own name, not the client's filename — keeps the argv/path free of
      // anything client-controlled.
      const p = path.join(dir, `image-${i + 1}.${IMAGE_EXT[img.mediaType] ?? "bin"}`);
      await fsp.writeFile(p, img.data, { mode: 0o600 });
      paths.push(p);
    }
    return { paths, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
