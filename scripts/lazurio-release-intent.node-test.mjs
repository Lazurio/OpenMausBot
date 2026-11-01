// The release intent a pull request carries: scripts/lazurio-release-intent.mjs.
//   node --test scripts/lazurio-release-intent.node-test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeTest from "node:test";

import { parseIntent, SCHEMA } from "./lazurio-release-intent.mjs";

const intent = (fields) => JSON.stringify({ schema_version: SCHEMA, version: "0.1.130-lazurio.4", upstream_tag: "v0.1.130", ...fields });

NodeTest.test("a valid intent names the version and the upstream tag it stands on", () => {
  NodeAssert.deepEqual(parseIntent(intent({})), { version: "0.1.130-lazurio.4", upstreamTag: "v0.1.130" });
});

NodeTest.test("anything else is refused with the reason", () => {
  for (const [text, reason] of [
    ["not json", /not JSON/],
    ["[]", /not an object/],
    [intent({ schema_version: "v0" }), /schema_version/],
    [intent({ version: "0.1.130" }), /X\.Y\.Z-lazurio\.N/],
    [intent({ version: "0.1.130-lazurio.0" }), /X\.Y\.Z-lazurio\.N/],
    [intent({ upstream_tag: "main" }), /upstream stable tag/],
    [intent({ version: "0.1.131-lazurio.1" }), /does not stand on upstream v0\.1\.130/],
    [intent({ force: true }), /unknown fields: force/],
  ]) {
    const result = parseIntent(text);
    NodeAssert.ok(result instanceof Error, text);
    NodeAssert.match(result.message, reason);
  }
});

NodeTest.test("the committed intent is valid", async () => {
  NodeAssert.ok(!(parseIntent(await NodeFSP.readFile("lazurio/release-intent.json", "utf8")) instanceof Error));
});
