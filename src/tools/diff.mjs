// Shapes a list of changed files (from compare or from a pull request) for a
// model: a short header per file, and the patch with a cap per file and in
// total.
export const MAX_PATCH_LINES_PER_FILE = 300;
export const MAX_PATCH_LINES_TOTAL = 1_500;

const NOISY = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum|composer\.lock)$|\.min\.(js|css)$|\.map$/;

export function formatFiles(files, { withPatch = true } = {}) {
  const out = [];
  let budget = MAX_PATCH_LINES_TOTAL;
  const dropped = [];
  for (const f of files) {
    const moved = f.previous_filename ? ` (from ${f.previous_filename})` : "";
    out.push(`--- ${f.status} ${f.filename}${moved}  +${f.additions} -${f.deletions}`);
    if (!withPatch) continue;
    if (!f.patch) {
      out.push("    (no text diff: binary or too large)");
      continue;
    }
    if (NOISY.test(f.filename)) {
      out.push("    (lockfile or generated file: diff not shown)");
      continue;
    }
    if (budget <= 0) {
      dropped.push(f.filename);
      continue;
    }
    const lines = f.patch.split("\n");
    const take = Math.min(lines.length, MAX_PATCH_LINES_PER_FILE, budget);
    out.push(...lines.slice(0, take));
    budget -= take;
    if (take < lines.length) out.push(`    [diff cut: ${lines.length - take} more lines. Read the file with read_files to see all of it]`);
  }
  if (dropped.length) out.push("", `Diff not shown, because the answer reached its size limit: ${dropped.join(", ")}`);
  return out.join("\n");
}
