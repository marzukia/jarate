---
name: Feature / refactor
about: A new capability, scope addition, or non-trivial refactor.
title: "feat: <short subject>"
labels: enhancement
---

## Goal

One paragraph. What this change unlocks and why now. If it comes from a
lead decision, quote the call and the date.

## Current state

How the code behaves today. Concrete files, line ranges, modules.

## Target state

How the code should behave after. Specific: which files import which
symbols, which endpoints change.

## Required changes

Numbered list of concrete edits; each maps to a file or small set of
files. Call out deletions explicitly.

1. ...
2. ...

## Acceptance criteria

Machine-checkable where possible (`grep`, test names, build output).
One bullet per criterion.

- [ ] ...

## Out of scope

Adjacent improvements get their own issues — link them here if filed.

## Risks

What's load-bearing, what could go wrong, which assumptions might be
wrong.
