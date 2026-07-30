# Port unique agy-acp capabilities into antigravity-acp

Implemented. See CHANGELOG [Unreleased].

## Delivered

1. Config options: `effort`, `sandbox`, `skip_permissions`, mode `accept-edits`
2. Native agy flags: `--effort`, `--sandbox`, `--mode plan|accept-edits`
3. Thought streaming: AgentText field 3 → `agent_thought_chunk`
4. Swallowed-error detection via `src/agy/logScan.ts`
5. Capability ads: streaming + prompt text
6. Plan mode uses `--mode plan` (no prompt injection)
