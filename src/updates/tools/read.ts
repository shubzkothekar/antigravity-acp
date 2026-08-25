import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { StepRow } from "../../types";
import {
	asNum,
	asStr,
	codeBlock,
	fsPath,
	parseRawInput,
	pick,
	toDisplayPath,
	toolCallUpdate,
} from "../utils";

/**
{
  "idx": 38,
  "stepType": 8,
  "parsedPayload": {
    "validityCheck": "8",
    "toolRun": {
      "call": {
        "callId": "e46phs2j",
        "namePrimary": "view_file",
        "rawInputJson": "{\"AbsolutePath\":\"/Users/user/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md\",\"toolAction\":\"Viewing file\",\"toolSummary\":\"File view\"}",
        "nameSecondary": "view_file"
      },
      "titlePrimary": "File view",
      "titleSecondary": "Viewing file"
    },
    "viewFile": {
      "fileUri": "file:///Users/user/.gemini/antigravity-cli/builtin/skills/antigravity_guide/SKILL.md",
      "endLine": "53",
      "startLine": "1",
      "content": "---\nname: antigravity-guide\ndescription: Provides a comprehensive guide, quick reference, and sitemap for Google Antigravity (AGY), including the Antigravity CLI (agy), Antigravity 2.0, Antigravity IDE, Python SDK, slash commands, keybindings, and customizations (skills, rules, MCP, sidecars). Activate this skill when the user asks questions about how to use, configure, or customize Antigravity, AGY, the agy CLI, the Antigravity IDE, or Antigravity 2.0.\n---\n\n# Google Antigravity (AGY) Guide & Sitemap\n\nGoogle Antigravity is an AI-first development platform. Depending on which\nsurface the user is asking about, you **MUST** read the corresponding\nsubdocumentation in the `references/` directory of this skill:\n\n## 1. Surfaces Sitemap (Offline Subdocs)\n\n-   **Antigravity CLI (`agy`)**: [references/cli.md](references/cli.md)\n    -   Covers TUI navigation, keyboard shortcuts, CLI-only slash commands, and\n        `settings.json` configuration keys.\n-   **Antigravity IDE**: [references/ide.md](references/ide.md)\n    -   Covers the standalone AI-first IDE, sidebar chat panels, and inline code\n        lenses.\n-   **Antigravity 2.0**: [references/app.md](references/app.md)\n    -   Covers the parallel desktop application, left-hand sidebar, chat canvas,\n        and the HTML Auxiliary Pane (Subagents, Background Tasks, Artifacts,\n        Files Changed, Terminals).\n-   **Antigravity SDK**: [references/sdk.md](references/sdk.md)\n    -   Covers the public Python SDK\n        (https://github.com/google-antigravity/antigravity-sdk-python) for\n        programmatic agent leasing, orchestration APIs, and custom tool\n        exposing.\n\n--------------------------------------------------------------------------------\n\n## 2. Smart Hybrid Retrieval: When to Fetch Live Docs\n\nThe offline subdocs provide excellent quick references. However, if the user\nasks for the latest updates, advanced Vertex AI integrations, or complex setups\nnot covered here, you **MUST** dynamically fetch the live page from the official\nsitemap:\n\n<!-- LINT.IfChange(sitemap) -->\n\n-   **Main Documentation Home**: `https://antigravity.google/docs`\n-   **Skills**: `https://antigravity.google/docs/skills`\n-   **Rules**: `https://antigravity.google/docs/rules`\n-   **Hooks**: `https://antigravity.google/docs/hooks`\n-   **Plugins**: `https://antigravity.google/docs/plugins`\n-   **Sidecars**: `https://antigravity.google/docs/sidecars`\n-   **Model Context Protocol (MCP)**: `https://antigravity.google/docs/mcp`\n-   **Browser Automation & Testing**: `https://antigravity.google/docs/browser`\n-   **Agent Permissions & Security**:\n    `https://antigravity.google/docs/agent-permissions`\n-   **Changelog & Release Notes**: `https://antigravity.google/changelog`\n-   **Troubleshooting & Support**: `https://antigravity.google/support`\n    <!-- LINT.ThenChange(//depot/google3/third_party/gemini_coder/agent_ui_toolkit/dev/appVariant/externalAppVariant.ts:custom_links) -->\n",
      "nextLine": "54",
      "fileSizeOrTotal": "2945"
    }
  }
}

{
  "idx": 8,
  "stepType": 9,
  "stepPayload": {
    "validityCheck": "9",
    "toolRun": {
      "call": {
        "callId": "sd03qxgj",
        "namePrimary": "list_dir",
        "rawInputJson": "{\"DirectoryPath\":\"/Users/user/Desktop/agy-acp\",\"toolAction\":\"Analyzing directory\",\"toolSummary\":\"Directory analysis\"}",
        "nameSecondary": "list_dir"
      },
      "titlePrimary": "Directory analysis",
      "titleSecondary": "Analyzing directory"
    },
    "listDirectory": {
      "dirUri": "file:///Users/user/Desktop/agy-acp",
      "entries": [
        {
          "name": ".DS_Store",
          "fileSize": "6148"
        },
        {
          "name": ".git",
          "isDirectory": "1"
        },
        {
          "name": ".gitignore",
          "fileSize": "17"
        },
        {
          "name": "README.md",
          "fileSize": "2844"
        },
        {
          "name": "src",
          "isDirectory": "1"
        }
      ]
    }
  }
}
*/

export function readUpdate(stepRow: StepRow, cwd?: string): SessionUpdate {
	const { stepPayload, stepType } = stepRow;
	const toolRun = stepPayload.toolRun;

	const rawInput = parseRawInput(stepRow);
	const displayCwd = fsPath(cwd) ?? undefined;
	const name = toolRun?.call?.namePrimary ?? "";
	const view = stepPayload.viewFile;
	const list = stepPayload.listDirectory;

	let title = "Read";
	const content: Record<string, unknown>[] = [];
	const locations: Record<string, unknown>[] = [];

	if (list || name === "list_dir" || stepType === 9) {
		// list_dir → "Read <dir>"
		const dir =
			fsPath(asStr(list?.dirUri)) ??
			fsPath(asStr(pick(rawInput, "DirectoryPath", "directoryPath")));
		const shown = dir ? toDisplayPath(dir, displayCwd) : "";
		title = shown ? `Read ${shown}` : "Read directory";

		if (dir) locations.push({ path: dir });

		const entries = (list?.entries ?? []).filter(
			(e) => e.name.trim().length > 0,
		);
		if (entries.length > 0) {
			const body = entries
				.map((e) => `${e.name}${e.isDirectory !== 0 ? "/" : ""}`)
				.join("\n");
			content.push(codeBlock(body));
		} else if (stepRow.toolOutput && stepRow.toolOutput.trim().length > 0) {
			content.push(codeBlock(stepRow.toolOutput.trim()));
		}
	} else {
		// view_file → "Read <file>" or "Read <file>:<start>-<end>" for a range read.
		// The file path: prefer the agent's requested absolute path, then the
		// result's file URI.
		const filePath =
			fsPath(
				asStr(pick(rawInput, "AbsolutePath", "absolutePath", "FilePath")),
			) ?? fsPath(asStr(view?.fileUri));
		const shown = filePath ? toDisplayPath(filePath, displayCwd) : "";

		// Prefer the 1-based request range; fall back to the result's range.
		const startLine =
			asNum(pick(rawInput, "StartLine", "startLine")) ??
			asNum(view?.startLine) ??
			1;
		const endLine =
			asNum(pick(rawInput, "EndLine", "endLine")) ?? asNum(view?.endLine);

		title = shown ? `Read ${shown}` : "Read file";
		if (shown) {
			title +=
				endLine !== null
					? `:${startLine === 0 ? 1 : startLine}-${endLine}`
					: "";
		}

		if (filePath) locations.push({ path: filePath, line: startLine });

		const body = asStr(view?.content) ?? stepRow.toolOutput;
		if (body && body.length > 0) {
			content.push(codeBlock(body));
		}
	}

	return toolCallUpdate({ stepRow, title, kind: "read", content, locations });
}
