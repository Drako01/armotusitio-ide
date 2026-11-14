# ArmotuSitio IDE privacy policy

Last updated: November 13, 2026.

This policy describes data processing associated with ArmotuSitio IDE, an open-source development environment based on Code - OSS. It covers the IDE's project-specific features and distinguishes local storage from connections to external services. The separate [ArmotuSitio website policy](https://armotusitio.com.ar/privacidad/) covers use of that website.

## Maintainer and contact

ArmotuSitio IDE is maintained by Alejandro Daniel Di Stefano, operating under the ArmotuSitio name. For privacy questions or requests about information provided to the maintainer, use the contact channels published on the [ArmotuSitio website](https://armotusitio.com.ar/). General product questions may also be raised in the [public repository](https://github.com/Drako01/armotusitio-ide). Do not post credentials, private source code, identity documents or other sensitive information in public issues.

## Information processed locally

The IDE reads and processes files, paths, configuration, diagnostics and terminal output to provide editing and development features. Chat features can store conversation history, project memory, execution records, checkpoints, diffs, usage receipts and operational logs in the IDE's local storage or project directories. These records can contain personal information or confidential project material supplied by the user or present in a workspace.

Provider profiles and authentication material may also be stored by the relevant provider's CLI. Supported IDE-managed integration secrets use VS Code's SecretStorage API; the operating system and installed provider tools determine the underlying credential storage. This does not mean that every credential managed by an extension or external tool uses that API.

## AI providers and connected tools

When you use Claude Code, Codex or another configured integration, your instructions and the context used for that task can be transmitted to its provider. This may include source code, selected files, file paths, diagnostics, tool results and conversation content. An assistant can request additional context during a task, subject to the applicable permissions and configuration. Using an online AI provider is not an entirely local operation.

The selected provider processes this information under its own terms, privacy policy, account settings and retention rules. ArmotuSitio does not determine or promise a provider's training, retention or deletion practices. Review those settings before using confidential material.

MCP servers, Work Management, terminal commands, extensions and other connected tools may access or transmit information according to their functionality and permissions. Optional webhooks and OpenTelemetry export send notifications or traces to the endpoints you configure. Leave these integrations unconfigured if you do not want those connections. Do not assume that installing an extension or running a command keeps its data local.

## Updates, downloads and extensions

The IDE's distribution configuration uses GitHub to check for and download releases, and Open VSX as its extension catalog. Requests to these services expose normal connection information, such as IP address and request metadata, to their operators. Extensions, language services, remote development tools and provider CLIs can make additional network connections governed by their own configuration and policies.

## Diagnostics and usage information

The IDE records operational information needed for features such as execution history, troubleshooting and provider-reported usage accounting. Local usage metrics are not a guarantee that a provider reports all consumption. Diagnostic and telemetry behavior can also depend on inherited Code - OSS functionality, installed extensions, external tools and user settings. Review the IDE's telemetry settings and each extension's disclosures; this policy does not claim that all components are telemetry-free.

## Purpose, retention and deletion

Information is processed to provide editing, AI assistance, task execution, recovery, authentication, updates and user-configured integrations. Local records remain subject to the feature's storage limits, cleanup behavior and your management of the IDE profile and workspace; there is no single retention period for every record.

Use the relevant history, account, project-memory and integration controls to inspect or remove supported records. Back up work before removing local application data. Removing a local record or disconnecting an account does not erase information already sent to a provider, copied into a workspace, included in a backup or published on GitHub. Request deletion of externally held information from the service responsible for it. For personal information sent directly to the maintainer, contact the maintainer through the website channels above.

## Security and user choices

Workspace trust, approvals, permission rules and available provider sandbox controls help restrict operations. They do not make every extension, external command or AI service safe, or guarantee that secrets cannot enter logs or transmitted context. Review permissions, use the least access necessary and avoid including secrets in prompts or public reports.

You can use ordinary editing features without starting an AI conversation, choose which providers and extensions to use, and configure or disconnect optional integrations. Connected services may process data in other countries; their policies explain the applicable processing locations and protections.

## Changes

Changes to this policy are published in this file with an updated date. Its revision history is available in the repository. Before using a new integration, review both this policy and the relevant service's own disclosures.
