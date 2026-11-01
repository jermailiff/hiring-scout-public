import { test } from "node:test";
import assert from "node:assert/strict";
import { hiringSignals } from "./x-posts.js";

test("recognises hiring roundup openers even without a named role", () => {
  assert.deepEqual(hiringSignals({ text: "Startups hiring right now: a thread below", links: [] }), ["hiring"]);
});

test("captures jobs, careers and a careers link without inventing a vacancy", () => {
  assert.deepEqual(hiringSignals({ text: "Jobs and careers", links: [] }), ["jobs", "careers"]);
  assert.deepEqual(hiringSignals({ text: "Our team", links: [
    { url: "https://t.co/example", label: "acme.com", expandedUrl: "https://acme.com/careers" },
  ] }), ["careers_link"]);
});

test("does not match substrings such as rehiringly or jobsite", () => {
  assert.deepEqual(hiringSignals({ text: "jobsite rehiringly", links: [] }), []);
});

test("generic company link alone needs hiring-conversation context", () => {
  assert.deepEqual(hiringSignals({ text: "https://example.com", links: [
    { url: "https://example.com", label: "example.com", expandedUrl: null },
  ] }), []);
});

test("an account of someone's existing job is not itself a jobs signal", () => {
  assert.deepEqual(hiringSignals({ text: "My friend has a well-paid job", links: [] }), []);
  assert.deepEqual(hiringSignals({ text: "See our job openings", links: [] }), ["jobs"]);
});
