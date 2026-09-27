---
name: jev-router
description: Use live Jev to choose among two or more real Antigravity tools, models, or subagents. Decision only; never execute the selected capability automatically.
---

# JevRouter for Antigravity

At the first meaningful choice between available capabilities, announce `JevRouter: routing the next step`, gather the exact current candidates, and run the shared wrapper. Skip trivial chat and operations the user has already specified as a single path.

```powershell
$inputObject = @{
  request = "<current task and next-step question>"
  context = @{ next_step = "<what has already been observed>" }
  candidates = @(
    @{ name = "<exact candidate 1>"; description = "<what it can do>" },
    @{ name = "<exact candidate 2>"; description = "<what it can do>" }
  )
} | ConvertTo-Json -Depth 8
$inputObject | node "${RUNTIME_ROOT}\bin\jevrouter-route.mjs" route --stdin
```

Read the JSON result and report `decision_id`, `status`, `decision.selected`, and the live provider. A selected result is only a recommendation; use Antigravity's normal permission and confirmation checks before acting. If Jev fails or returns `no_decision`, disclose the fallback and continue with normal reasoning. Never put a key in a prompt, argument, file, or log.
