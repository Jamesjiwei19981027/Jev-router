---
name: jevrouter
description: Use Jev to choose the next tool, model, or subagent when a task has competing capability choices, the user asks for routing, or the next step is uncertain. Use the real current task and available candidates.
---

# JevRouter

Announce “JevRouter: routing the next step” when starting. A past setup check is not a routing decision for the current task.

At the first meaningful capability choice, and again when an observation changes the next step, gather the tools, models, or subagents actually available to this host. Submit the current task and at least two plausible choices; exclude JevRouter itself. Keep exact host tool names. Skip trivial chat and steps whose sole permitted operation the user already specified.

Use the installed wrapper. It reads the inherited Jev key. Do not print keys, put them in arguments, or replace them with placeholders.

For PowerShell, pass a JSON request on stdin:

```powershell
$inputObject = @{
  request = "Find the latest public source and then summarize it"
  context = @{ next_step = "Find the source before summarizing it" }
  candidates = @(
    @{ name = "web_search"; description = "Find current public web sources" },
    @{ name = "summarize"; description = "Summarize sources already retrieved" }
  )
} | ConvertTo-Json -Depth 8
$inputObject | node "${RUNTIME_ROOT}\bin\jevrouter-route.mjs" route --stdin
```

Replace the task and candidates with this turn's real capabilities. Model or subagent candidates use `{id,name,type,description}` with `type: model` or `subagent`. Read JSON on stdout and progress on stderr. State the returned `decision_id`, `status`, `decision.selected`, and whether the provider was live or demo. If `status=selected`, execute only that available capability through the host's own permission checks. If confirmation is required, obtain it first.

On `no_decision`, invalid input, missing credentials, or network error, explain the fallback and gather better inputs; never describe a failed or demo call as live Jev routing. This is a routing aid: it does not switch the host's underlying model, spawn agents, or execute returned IDs automatically.
