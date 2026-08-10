import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflow = readFileSync(
  path.join(root, ".github/workflows/public-sensitivity-owner-receipt-caller.yml"),
  "utf8",
);

const canonicalWorkflow = `name: Public Sensitivity Owner Receipt Caller

on:
  workflow_dispatch:
    inputs:
      observed_at:
        required: true
        type: string

permissions:
  contents: read
  actions: read

jobs:
  receipt:
    uses: AquilaXk/easysubway/.github/workflows/public-sensitivity-owner-receipt.yml@fa2f2602573651af6694e7f56077414b685987b9
    with:
      observed_at: \${{ inputs.observed_at }}
    secrets:
      D20_SECRET_SCANNING_ALERTS_READ_TOKEN: \${{ secrets.D20_SECRET_SCANNING_ALERTS_READ_TOKEN }}
`;

function assertCanonicalWorkflow(candidate) {
  assert.equal(candidate, canonicalWorkflow);
}

test("D20 owner receipt caller는 coordinator 관찰 시각을 immutable common workflow에 최소 권한으로 위임한다", () => {
  assertCanonicalWorkflow(workflow);
});

test("D20 owner receipt caller canonical validator는 계약 변형을 거부한다", () => {
  const mutations = [
    ["missing input", (value) => value.replace(/    inputs:[\s\S]*?\n\npermissions:/, "\npermissions:")],
    ["wrong input", (value) => value.replace("observed_at:", "reported_at:")],
    ["default input", (value) => value.replace("        type: string", "        type: string\n        default: 2026-08-10T00:00:00Z")],
    ["missing forwarding", (value) => value.replace(/    with:\n      observed_at: \$\{\{ inputs\.observed_at \}\}\n/, "")],
    ["extra forwarding", (value) => value.replace("      observed_at: ${{ inputs.observed_at }}", "      observed_at: ${{ inputs.observed_at }}\n      source: coordinator")],
    ["wrong forwarding", (value) => value.replace("${{ inputs.observed_at }}", "${{ github.event.inputs.observed_at }}")],
    ["old pin", (value) => value.replace("fa2f2602573651af6694e7f56077414b685987b9", "3d1590baa98c929ceabd0d2d44414cebcc643c6f")],
    ["mutable pin", (value) => value.replace("fa2f2602573651af6694e7f56077414b685987b9", "main")],
    ["extra secret", (value) => value.replace("      D20_SECRET_SCANNING_ALERTS_READ_TOKEN: ${{ secrets.D20_SECRET_SCANNING_ALERTS_READ_TOKEN }}", "      D20_SECRET_SCANNING_ALERTS_READ_TOKEN: ${{ secrets.D20_SECRET_SCANNING_ALERTS_READ_TOKEN }}\n      EXTRA_TOKEN: ${{ secrets.EXTRA_TOKEN }}")],
    ["extra permission", (value) => value.replace("  actions: read", "  actions: read\n  issues: read")],
    ["extra job", (value) => `${value}  extra:\n    uses: AquilaXk/easysubway/.github/workflows/public-sensitivity-owner-receipt.yml@fa2f2602573651af6694e7f56077414b685987b9\n`],
  ];

  for (const [name, mutate] of mutations) {
    assert.throws(() => assertCanonicalWorkflow(mutate(canonicalWorkflow)), undefined, name);
  }
});
