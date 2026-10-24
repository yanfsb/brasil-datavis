import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBairro } from "./normalizeBairro.ts";

test("neighborhood key is trimmed, collapsed, and uppercased", () => {
  const name = normalizeBairro("  vila   nova\tdo\nlimão  ");
  assert.equal(name.key, "VILA NOVA DO LIMÃO");
  assert.equal(name.label, "  vila   nova\tdo\nlimão  ");
});

test("accents stay in the key so different spellings do not merge", () => {
  assert.equal(normalizeBairro("São João").key, "SÃO JOÃO");
  assert.notEqual(normalizeBairro("São João").key, normalizeBairro("Sao Joao").key);
});

test("an empty label stays an empty key and keeps the original text", () => {
  assert.deepEqual(normalizeBairro(""), { key: "", label: "" });
  assert.deepEqual(normalizeBairro("   "), { key: "", label: "   " });
});

test("an already normal label is unchanged as a key", () => {
  assert.equal(normalizeBairro("CENTRO").key, "CENTRO");
  assert.equal(normalizeBairro("CENTRO").label, "CENTRO");
});
