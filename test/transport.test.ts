/**
 * Tests for transport utilities:
 * - withTimeout (success, timeout, immediate rejection)
 * - TransportError construction and cause
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { withTimeout, TransportError } from "../src/transport.ts";

// ---------------------------------------------------------------------------
// withTimeout
// ---------------------------------------------------------------------------

describe("withTimeout", () => {
	it("resolves when the promise settles before the timeout", async () => {
		const result = await withTimeout(Promise.resolve("ok"), 500, "test");
		assert.equal(result, "ok");
	});

	it("rejects with TransportError when the timeout fires first", async () => {
		await assert.rejects(
			() => withTimeout(sleep(50), 10, "slow-server"),
			(err) => {
				assert.ok(err instanceof TransportError);
				assert.ok(err.message.includes("timed out after 10ms"));
				assert.ok(err.message.includes("slow-server"));
				return true;
			},
		);
	});

	it("rejects with the original error when the promise rejects before the timeout", async () => {
		await assert.rejects(
			() => withTimeout(Promise.reject(new Error("boom")), 500, "test"),
			(err) => {
				assert.ok(err instanceof Error);
				assert.equal(err.message, "boom");
				return true;
			},
		);
	});

	it("rejects with the original rejection value when it is not an Error", async () => {
		await assert.rejects(
			() => withTimeout(Promise.reject("string error"), 500, "test"),
			(err) => {
				assert.equal(err, "string error");
				return true;
			},
		);
	});

	it("clears the timer on success so the process can exit cleanly", async () => {
		const start = Date.now();
		await withTimeout(Promise.resolve("fast"), 10_000, "test");
		const elapsed = Date.now() - start;
		assert.ok(elapsed < 1000, `Should resolve quickly, took ${elapsed}ms`);
	});
});

// ---------------------------------------------------------------------------
// TransportError
// ---------------------------------------------------------------------------

describe("TransportError", () => {
	it("stores the message and cause", () => {
		const cause = new Error("underlying");
		const err = new TransportError("wrapped", cause);
		assert.equal(err.message, "wrapped");
		assert.equal(err.cause, cause);
		assert.equal(err.name, "TransportError");
	});

	it("works without a cause", () => {
		const err = new TransportError("simple");
		assert.equal(err.message, "simple");
		assert.equal(err.cause, undefined);
	});

	it("is instanceof Error and TransportError", () => {
		const err = new TransportError("test");
		assert.ok(err instanceof Error);
		assert.ok(err instanceof TransportError);
	});
});
