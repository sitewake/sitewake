import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

/** Reads a `--token: #hex;` declaration, following one level of var() alias. */
function token(name) {
  const direct = css.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{3,8})`));
  if (direct) return direct[1];
  const alias = css.match(new RegExp(`${name}:\\s*var\\((--[a-z0-9-]+)\\)`));
  if (alias) return token(alias[1]);
  throw new Error(`token_not_found:${name}`);
}

function channels(hex) {
  let value = hex.replace("#", "");
  if (value.length === 3) value = value.split("").map((c) => c + c).join("");
  return [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = channels(hex).map((raw) => {
    const channel = raw / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [x, y] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const AA = 4.5;

test("text tokens meet WCAG AA on both surface and paper backgrounds", () => {
  const surface = token("--sa-surface");
  const paper = token("--sa-paper");
  for (const name of ["--sa-ink", "--sa-ink-2", "--sa-ink-3", "--sa-accent-ink", "--sa-ok", "--sa-danger", "--sa-warn", "--sw-muted"]) {
    const value = token(name);
    assert.ok(
      contrast(value, surface) >= AA,
      `${name} (${value}) is ${contrast(value, surface).toFixed(2)}:1 on ${surface}, needs ${AA}:1`,
    );
    assert.ok(
      contrast(value, paper) >= AA,
      `${name} (${value}) is ${contrast(value, paper).toFixed(2)}:1 on ${paper}, needs ${AA}:1`,
    );
  }
});

test("every status and outcome pill pairs foreground with its own soft background at AA", () => {
  const pairs = [
    ["--sa-ok", "--sa-ok-soft"],
    ["--sa-danger", "--sa-danger-soft"],
    ["--sa-warn", "--sa-warn-soft"],
    ["--sa-accent-ink", "--sa-accent-soft"],
    ["--sa-outcome-success", "--sa-outcome-success-soft"],
    ["--sa-outcome-no-result", "--sa-outcome-no-result-soft"],
    ["--sa-outcome-business-rejection", "--sa-outcome-business-rejection-soft"],
    ["--sa-outcome-execution-fault", "--sa-outcome-execution-fault-soft"],
    ["--sa-outcome-unknown", "--sa-outcome-unknown-soft"],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrast(token(fg), token(bg));
    assert.ok(ratio >= AA, `${fg} on ${bg} is ${ratio.toFixed(2)}:1, needs ${AA}:1`);
  }
});

test("the accent pill does not use the raw accent, which fails AA on its soft background", () => {
  // Guards a specific past regression: --sa-accent is 3.93:1 on --sa-accent-soft.
  assert.ok(contrast(token("--sa-accent"), token("--sa-accent-soft")) < AA);
  assert.match(css, /\.sa-pill--accent\s*{[^}]*color:\s*var\(--sa-accent-ink\)/);
});

test("outcome status is never conveyed by color alone", () => {
  // WCAG 1.4.1: each of the five outcome pills carries a glyph as well as a hue.
  for (const status of ["success", "no-result", "business-rejection", "execution-fault", "unknown"]) {
    assert.match(
      css,
      new RegExp(`\\.sa-pill--${status}::before\\s*{\\s*content:`),
      `.sa-pill--${status} is missing its non-color glyph`,
    );
  }
});

test("interactive elements have a visible focus ring", () => {
  assert.match(css, /:focus-visible\s*{[^}]*outline:/);
});
