---
name: Bug report
about: A regression or broken behaviour with reproducible evidence.
title: "fix: <short subject>"
labels: bug
---

## Symptom

What the user sees / what's broken. One or two sentences. Include the
endpoint, page, or command. Link the deploy or commit where it surfaced
if known.

## Verified evidence

Logs, screenshots, or test output that proves the bug exists. Paste
directly — don't link to ephemeral chat history.

```
<paste log / output / repro command>
```

## Root cause

What's actually wrong. Reference file(s) and line(s). If unknown, write
"unknown — investigation needed" and stop here; the fix branch is
blocked until this is filled in.

## Required fix

The smallest change that resolves the root cause. Call out anything the
fix must **not** touch.

## Tests

How we'll prove this stays fixed. Prefer a regression test that fails
without the fix and passes with it. Name the test file and case.

## Out of scope

What this issue deliberately does **not** cover.
