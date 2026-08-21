# JSHarvest — Privacy Policy

_Last updated: 2026-08-21_

## Summary

JSHarvest processes data **on your own device**. It sends nothing anywhere by default, contains no analytics, tracking or telemetry, and the developer receives no data from you whatsoever.

## What JSHarvest stores, and where

| Data | Where | Lifetime |
|---|---|---|
| The list of JavaScript resources observed on pages you visit (URLs, HTTP status, size, timing) | `storage.session` in your browser | Cleared when the browser closes |
| Your settings | `storage.local` on your device | Until you change or clear them |
| Optional capture snapshots used by the Diff view | `storage.local` on your device | Until you clear history in Options |
| Your AI API key, if you provide one | `storage.local` on your device | Until you remove it |

None of this is synced to any account, and none of it leaves your device unless you use one of the two optional features below.

## Features that contact other servers

Both are **off by default** and both require an explicit action from you.

### 1. Deep Scan

When you press **Deep Scan**, JSHarvest downloads JavaScript files **from the website you are currently inspecting** in order to analyse them as text. It sends no data to any third party, and it never executes the code it downloads. Requests are made without cookies (`credentials: omit`).

### 2. AI analysis

This feature only works if you enable it and supply **your own** third-party API key (Anthropic, OpenAI, Google Gemini, Groq or OpenRouter). When you run an analysis, JSHarvest sends a **summary of the collected inventory** to the provider you chose, billed to your own account:

- totals and risk counts
- third-party host names and vendor names
- first-party bundle filenames
- mined findings, with secret values **already masked**
- source-map statistics

**Raw secret values are never stored by JSHarvest and are therefore never transmitted.** With the *Redact context* option enabled (the default), file paths and raw endpoint values are withheld from the AI as well.

Your API key is stored only in your browser's local storage. It is never synced and is sent only to the provider it belongs to. The developer of JSHarvest never receives it.

Data you send to an AI provider is subject to that provider's own privacy policy and data-retention terms.

## What JSHarvest never does

- No analytics, no telemetry, no crash reporting
- No advertising, no user profiling, no data sales
- No account, no sign-in, no server operated by the developer
- No reading of browser history, bookmarks, passwords or cookies

## Removing your data

Uninstalling the extension removes all stored data. You can also clear it at any time: **Clear** in the popup empties the current capture, and **Clear all history** in Options removes stored snapshots. Removing your API key from Options deletes it from local storage.

## Contact

Questions about this policy can be sent through the add-on's support channel on addons.mozilla.org.
