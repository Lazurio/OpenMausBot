import { expect, it, vi } from "vitest";
import type { PersonQuestions } from "../lazurio-person-questions.ts";
import { serviceAllowed } from "../request-auth.ts";
import { createPersonQuestionRoutes } from "./lazurio-person-questions.ts";

it("a service-trust bot cannot attest a T3 answer with the CLI header", async () => {
  const path = `/api/person-questions/${"a".repeat(64)}/refresh`;
  const refresh = vi.fn();
  const route = createPersonQuestionRoutes({ refresh } as unknown as PersonQuestions);
  const json = vi.fn();
  await route({ path, method: "POST", req: { headers: { "x-openmausbot-cli": "1" } }, auth: { kind: "loopback", trust: "service", scopes: ["client"] }, res: {}, json, readBody: async () => ({ answer: "Publish" }) } as never);
  expect(json.mock.calls[0]?.[1]).toBe(403);
  expect(refresh).not.toHaveBeenCalled();
  expect(serviceAllowed("POST", path)).toBe(false);
  expect(serviceAllowed("POST", path.replace("refresh", "answer"))).toBe(false);
});
